import * as vscode from 'vscode';
import { Session, SessionSummary, Turn } from './sessionTree';

type Relation = 'fork' | 'manual';

type Node =
  | { kind: 'session'; summary: SessionSummary; depth: number; parentId?: string; relation?: Relation }
  | { kind: 'turn'; sessionId: string; turn: Turn }
  | { kind: 'searchSession'; summary: SessionSummary; hits: Turn[] }
  | { kind: 'searchHit'; sessionId: string; turn: Turn };

interface Graph {
  summaries: SessionSummary[];
  parentOf: Map<string, string>;
  relationOf: Map<string, Relation>;
}

function sessionTitle(s: SessionSummary): string {
  return s.firstPrompt || s.projectName || s.id;
}

// Compute highlight ranges for every occurrence of `q` (already lowercased) in
// `text`, returning a TreeItemLabel the tree renders with the matches bolded.
function highlightLabel(text: string, q: string): vscode.TreeItemLabel {
  const highlights: [number, number][] = [];
  if (q) {
    const lower = text.toLowerCase();
    let i = lower.indexOf(q);
    while (i !== -1) {
      highlights.push([i, i + q.length]);
      i = lower.indexOf(q, i + q.length);
    }
  }
  return { label: text, highlights };
}

// Build a snippet of `oneLine` centered on the first match of `q`.
function snippetAround(oneLine: string, q: string): string {
  const at = oneLine.toLowerCase().indexOf(q);
  if (at === -1) return oneLine.slice(0, 80);
  const start = Math.max(0, at - 30);
  const end = at + q.length + 50;
  return (start > 0 ? '…' : '') + oneLine.slice(start, end) + (end < oneLine.length ? '…' : '');
}

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cache: {
    byId: Map<string, SessionSummary>;
    childrenOf: Map<string, SessionSummary[]>;
    parentOf: Map<string, string>;
    relationOf: Map<string, Relation>;
    ordered: Node[];
  } | null = null;

  // Active search query (lowercased) and cached results.
  private search: string | null = null;
  private searchResults: { summary: SessionSummary; hits: Turn[] }[] | null = null;

  constructor(
    private loadGraph: () => Graph,
    private loadSession: (id: string) => Session | null
  ) {}

  refresh(): void {
    this.cache = null;
    this.searchResults = null;
    this._onDidChangeTreeData.fire();
  }

  // Enter/leave search mode. Pass null/empty to clear.
  setSearch(query: string | null): void {
    this.search = query && query.trim() ? query.trim().toLowerCase() : null;
    this.searchResults = null;
    this._onDidChangeTreeData.fire();
  }

  isSearching(): boolean {
    return this.search !== null;
  }

  private getGraph() {
    if (this.cache) return this.cache;

    const { summaries, parentOf, relationOf } = this.loadGraph();
    const byId = new Map<string, SessionSummary>();
    for (const s of summaries) byId.set(s.id, s);

    const childrenOf = new Map<string, SessionSummary[]>();
    const roots: SessionSummary[] = [];
    for (const s of summaries) {
      const parent = parentOf.get(s.id);
      if (parent && byId.has(parent)) {
        const arr = childrenOf.get(parent) ?? [];
        arr.push(s);
        childrenOf.set(parent, arr);
      } else {
        roots.push(s);
      }
    }

    const ordered: Node[] = [];
    const visit = (s: SessionSummary, depth: number, parentId?: string) => {
      ordered.push({
        kind: 'session',
        summary: s,
        depth,
        parentId,
        relation: parentId ? relationOf.get(s.id) : undefined,
      });
      for (const child of childrenOf.get(s.id) ?? []) {
        visit(child, depth + 1, s.id);
      }
    };
    for (const root of roots) visit(root, 0);

    this.cache = { byId, childrenOf, parentOf, relationOf, ordered };
    return this.cache;
  }

  // Sessions (with their matching user prompts) for the active search query.
  private getSearchResults() {
    if (this.searchResults || !this.search) return this.searchResults ?? [];
    const q = this.search;
    const results: { summary: SessionSummary; hits: Turn[] }[] = [];
    for (const summary of this.getGraph().byId.values()) {
      const session = this.loadSession(summary.id);
      if (!session) continue;
      const hits = session.turns.filter(
        t => t.type === 'user' && t.text && t.text.toLowerCase().includes(q)
      );
      if (hits.length > 0) results.push({ summary, hits });
    }
    this.searchResults = results;
    return results;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'searchSession') {
      const s = node.summary;
      const item = new vscode.TreeItem(
        highlightLabel(sessionTitle(s), this.search ?? ''),
        vscode.TreeItemCollapsibleState.Expanded
      );
      // Stable id keyed by query so the Expanded state sticks across renders.
      item.id = `search:${this.search}:session:${s.id}`;
      item.description = `${node.hits.length} match${node.hits.length > 1 ? 'es' : ''}`;
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.tooltip = `${sessionTitle(s)}\n${s.cwd}`;
      item.command = {
        command: 'agentChatTree.openSession',
        title: 'Open Tree View',
        arguments: [s.id],
      };
      return item;
    }

    if (node.kind === 'searchHit') {
      const oneLine = node.turn.text.replace(/\s+/g, ' ').trim();
      const snippet = snippetAround(oneLine, this.search ?? '');
      const item = new vscode.TreeItem(
        highlightLabel(snippet, this.search ?? ''),
        vscode.TreeItemCollapsibleState.None
      );
      item.id = `search:${this.search}:hit:${node.sessionId}:${node.turn.uuid}`;
      item.iconPath = new vscode.ThemeIcon('search');
      item.tooltip = oneLine;
      item.command = {
        command: 'agentChatTree.openSession',
        title: 'Open Session',
        arguments: [node.sessionId],
      };
      return item;
    }

    if (node.kind === 'session') {
      const g = this.getGraph();
      const s = node.summary;
      const isChild = node.depth > 0;
      const isManual = node.relation === 'manual';
      const mark = isManual ? '↳' : '⑂';

      const indent = node.depth > 1 ? '  '.repeat(node.depth - 1) : '';
      const connector = isChild ? `${indent}└─${mark} ` : '';
      const title = connector + sessionTitle(s);

      const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Collapsed);
      const date = s.startTime ? new Date(s.startTime).toLocaleString() : 'unknown';
      const tokens = ((s.totalInputTokens + s.totalOutputTokens) / 1000).toFixed(1);
      const children = g.childrenOf.get(s.id) ?? [];

      const parts = [`${s.turnCount} msgs · ${tokens}k`];
      if (children.length > 0) parts.push(`◇ ${children.length}`);
      item.description = parts.join('  ');

      const parent = node.parentId ? g.byId.get(node.parentId) : undefined;
      const relationLabel = isManual ? '↳ Child of' : '⑂ Forked from';
      item.tooltip =
        (isChild && parent ? `${relationLabel}: ${sessionTitle(parent)}\n\n` : '') +
        `${s.firstPrompt || '(no prompt)'}\n\n${s.projectName}\n${date}\n${s.cwd}`;
      item.iconPath = new vscode.ThemeIcon(
        isManual ? 'type-hierarchy-sub' : isChild ? 'git-branch' : 'comment-discussion'
      );
      item.contextValue = 'session';
      item.command = {
        command: 'agentChatTree.openSession',
        title: 'Open Tree View',
        arguments: [s.id],
      };
      return item;
    }

    // turn node (user prompt only)
    const t = node.turn;
    const oneLine = t.text.replace(/\s+/g, ' ').trim();
    const label = oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('account');
    item.tooltip = oneLine;
    item.command = {
      command: 'agentChatTree.openSession',
      title: 'Open Session',
      arguments: [node.sessionId],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    // Search mode: top level = matching sessions, children = matching prompts.
    if (this.search) {
      if (!node) {
        return this.getSearchResults().map(r => ({
          kind: 'searchSession' as const,
          summary: r.summary,
          hits: r.hits,
        }));
      }
      if (node.kind === 'searchSession') {
        return node.hits.map(turn => ({
          kind: 'searchHit' as const,
          sessionId: node.summary.id,
          turn,
        }));
      }
      return [];
    }

    const g = this.getGraph();

    if (!node) {
      return g.ordered;
    }

    if (node.kind === 'session') {
      const session = this.loadSession(node.summary.id);
      if (!session) return [];
      return session.turns
        .filter(turn => turn.type === 'user' && turn.text.trim())
        .map(turn => ({ kind: 'turn' as const, sessionId: node.summary.id, turn }));
    }

    return [];
  }
}
