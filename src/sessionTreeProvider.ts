import * as vscode from 'vscode';
import { Session, SessionSummary, Turn } from './sessionTree';

type Relation = 'fork' | 'manual';

type Node =
  | { kind: 'session'; summary: SessionSummary; depth: number; parentId?: string; relation?: Relation }
  | { kind: 'turn'; sessionId: string; turn: Turn };

interface Graph {
  summaries: SessionSummary[];
  parentOf: Map<string, string>;
  relationOf: Map<string, Relation>;
}

function sessionTitle(s: SessionSummary): string {
  return s.firstPrompt || s.projectName || s.id;
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

  constructor(
    private loadGraph: () => Graph,
    private loadSession: (id: string) => Session | null
  ) {}

  refresh(): void {
    this.cache = null;
    this._onDidChangeTreeData.fire();
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

    // Flatten to a single top-level list, but emit each root immediately
    // followed by its forks (depth-first), so forks sit right under their
    // origin while still rendering at the same tree level.
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

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'session') {
      const g = this.getGraph();
      const s = node.summary;
      const isChild = node.depth > 0;
      const isManual = node.relation === 'manual';
      // ⑂ for forks, ↳ for manually-attached child sessions.
      const mark = isManual ? '↳' : '⑂';

      // Connector prefix so a child visually hangs off its origin.
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
      // fork -> branch icon, manual child -> arrow, root -> chat icon.
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
    const g = this.getGraph();

    if (!node) {
      // All sessions (roots + forks) flat at the top level, fork-ordered.
      return g.ordered;
    }

    if (node.kind === 'session') {
      // A session expands to its own user prompts only (forks live at top level).
      const session = this.loadSession(node.summary.id);
      if (!session) return [];
      return session.turns
        .filter(turn => turn.type === 'user' && turn.text.trim())
        .map(turn => ({ kind: 'turn' as const, sessionId: node.summary.id, turn }));
    }

    return [];
  }
}
