import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getClaudeProjectsDir,
  listSessionFiles,
  findProjectDirForCwd,
  parseSession,
  buildForkGraph,
  SessionWatcher,
} from './logWatcher';
import { Session, SessionSummary, sessionToSummary } from './sessionTree';
import { buildWebviewHtml, ChildSessionRef } from './webviewBuilder';
import { SessionTreeProvider } from './sessionTreeProvider';

let panel: vscode.WebviewPanel | undefined;
let watcher: SessionWatcher | undefined;
let cachedSessions: SessionSummary[] = [];
let treeProvider: SessionTreeProvider | undefined;
let sidebarWatcher: SessionWatcher | undefined;
let extContext: vscode.ExtensionContext;

// Manually-declared parent links (child session id -> parent session id),
// independent of fork detection. Persisted in global state.
const MANUAL_PARENTS_KEY = 'agentChatTree.manualParents';
// Pending child-session creations: after launching a new session we don't yet
// know its id, so we record the parent + a snapshot of existing ids and link
// the first new id that appears.
const PENDING_CHILDREN_KEY = 'agentChatTree.pendingChildren';
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

interface PendingChild {
  parentId: string;
  knownIds: string[];
  createdAt: number;
}

function getManualParents(): Record<string, string> {
  return extContext.globalState.get<Record<string, string>>(MANUAL_PARENTS_KEY, {});
}

async function setManualParent(childId: string, parentId: string): Promise<void> {
  const map = { ...getManualParents(), [childId]: parentId };
  await extContext.globalState.update(MANUAL_PARENTS_KEY, map);
}

function getPendingChildren(): PendingChild[] {
  return extContext.globalState.get<PendingChild[]>(PENDING_CHILDREN_KEY, []);
}

async function addPendingChild(parentId: string, knownIds: string[]): Promise<void> {
  const list = [...getPendingChildren(), { parentId, knownIds, createdAt: Date.now() }];
  await extContext.globalState.update(PENDING_CHILDREN_KEY, list);
}

// Resolve pending child creations against the current set of session ids.
// Any session id that wasn't present when a new-child was launched is taken to
// be that child. Returns the (possibly updated) manual-parent map for use in
// the current render; persistence happens fire-and-forget.
function resolvePendingChildren(currentIds: string[]): Record<string, string> {
  const manual = { ...getManualParents() };
  const pending = getPendingChildren();
  if (pending.length === 0) return manual;

  const now = Date.now();
  const remaining: PendingChild[] = [];
  let changed = false;

  for (const p of pending) {
    const known = new Set(p.knownIds);
    const newId = currentIds.find(id => !known.has(id) && !manual[id]);
    if (newId) {
      manual[newId] = p.parentId;
      changed = true;
    } else if (now - p.createdAt < PENDING_TTL_MS) {
      remaining.push(p); // keep waiting
    } else {
      changed = true; // expired, drop
    }
  }

  if (changed) {
    void extContext.globalState.update(MANUAL_PARENTS_KEY, manual);
    void extContext.globalState.update(PENDING_CHILDREN_KEY, remaining);
  }
  return manual;
}

export function activate(context: vscode.ExtensionContext) {
  extContext = context;
  // Sidebar tree view.
  treeProvider = new SessionTreeProvider(
    () => loadSessionGraph(),
    (id) => loadSessionById(id)
  );
  const treeView = vscode.window.createTreeView('agentChatTreeSidebar', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Refresh the sidebar when session files change.
  const scope = getScanScope();
  sidebarWatcher = new SessionWatcher(() => treeProvider?.refresh());
  sidebarWatcher.watchDir(scope.onlyDir ?? getProjectsDir());
  context.subscriptions.push({ dispose: () => sidebarWatcher?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('agentChatTree.openPanel', () => {
      openBrowserPanel(context);
    }),
    vscode.commands.registerCommand('agentChatTree.refreshSidebar', () => {
      treeProvider?.refresh();
    }),
    vscode.commands.registerCommand('agentChatTree.search', () => {
      searchPrompts();
    }),
    vscode.commands.registerCommand('agentChatTree.clearSearch', () => {
      treeProvider?.setSearch(null);
      vscode.commands.executeCommand('setContext', 'agentChatTree.searching', false);
    }),
    vscode.commands.registerCommand('agentChatTree.resumeSession', (arg?: unknown) => {
      const id = sessionIdFromArg(arg);
      if (id) {
        resumeSession(id);
      }
    }),
    vscode.commands.registerCommand('agentChatTree.newChildSession', (arg?: unknown) => {
      const parentId = sessionIdFromArg(arg);
      if (parentId) {
        newChildSession(parentId);
      }
    }),
    vscode.commands.registerCommand('agentChatTree.deleteSession', (arg?: unknown) => {
      const id = sessionIdFromArg(arg);
      if (id) {
        deleteSession(id);
      }
    }),
    vscode.commands.registerCommand('agentChatTree.openSession', (arg?: unknown) => {
      const id = sessionIdFromArg(arg);
      if (id) {
        openSessionPanel(context, id);
      } else {
        openBrowserPanel(context);
      }
    }),
    vscode.commands.registerCommand('agentChatTree.refresh', () => {
      if (panel) {
        refreshPanel(context);
      }
    }),
    vscode.commands.registerCommand('agentChatTree.toggleScope', async () => {
      const config = vscode.workspace.getConfiguration('agentChatTree');
      const next = !config.get<boolean>('workspaceOnly', true);
      await config.update('workspaceOnly', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        next ? 'Agent Chat Tree: showing current workspace only' : 'Agent Chat Tree: showing all sessions'
      );
      treeProvider?.refresh();
      if (panel) {
        refreshPanel(context);
      }
    })
  );
}

function getProjectsDir(): string {
  const config = vscode.workspace.getConfiguration('agentChatTree');
  const configured = config.get<string>('claudeProjectsDir', '');
  return getClaudeProjectsDir(configured || undefined);
}

function isWorkspaceOnly(): boolean {
  const config = vscode.workspace.getConfiguration('agentChatTree');
  return config.get<boolean>('workspaceOnly', true);
}

function getMaxSessions(): number {
  return vscode.workspace.getConfiguration('agentChatTree').get<number>('maxSessions', 50);
}

// Claude Code session ids are UUIDs. Restrict to a safe charset so the id can
// never inject shell metacharacters when passed to a terminal.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

// Commands invoked from the tree's context menu receive the tree Node, while
// a node's `command` passes the id string directly. Accept both, and reject
// anything that isn't a well-formed session id.
function sessionIdFromArg(arg: unknown): string | undefined {
  let id: string | undefined;
  if (typeof arg === 'string') {
    id = arg;
  } else if (arg && typeof arg === 'object') {
    const node = arg as { kind?: string; summary?: { id?: string }; sessionId?: string };
    id = node.summary?.id ?? node.sessionId;
  }
  if (id && !isValidSessionId(id)) {
    vscode.window.showErrorMessage(`Invalid session id: ${id}`);
    return undefined;
  }
  return id;
}

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

// Resume a Claude Code session, either in an integrated terminal or in the
// Claude Code extension. Honors the `resumeTarget` setting; when set to "ask"
// (default) it prompts each time.
async function resumeSession(sessionId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('agentChatTree');
  let target = config.get<string>('resumeTarget', 'ask');

  if (target === 'ask') {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(terminal) Terminal',
          description: 'Run claude --resume in an integrated terminal',
          value: 'terminal',
        },
        {
          label: '$(window) Claude Code Extension',
          description: 'Resume in a Claude Code editor tab',
          value: 'extension',
        },
      ],
      { placeHolder: 'Resume this session in…' }
    );
    if (!pick) return;
    target = pick.value;
  }

  if (target === 'extension') {
    await resumeInExtension(sessionId);
  } else {
    resumeInTerminal(sessionId);
  }
}

function resumeInTerminal(sessionId: string): void {
  if (!isValidSessionId(sessionId)) {
    vscode.window.showErrorMessage(`Invalid session id: ${sessionId}`);
    return;
  }
  const session = loadSessionById(sessionId);
  const cwd = session?.cwd && fs.existsSync(session.cwd) ? session.cwd : undefined;
  const termName = `Claude: ${sessionId.slice(0, 8)}`;

  let term = vscode.window.terminals.find(t => t.name === termName);
  if (!term) {
    term = vscode.window.createTerminal({ name: termName, cwd });
  }
  term.show();
  term.sendText(`claude --resume ${sessionId}`);
}

async function resumeInExtension(sessionId: string): Promise<void> {
  if (!vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    const choice = await vscode.window.showWarningMessage(
      'Claude Code extension is not installed. Open in terminal instead?',
      'Open in Terminal'
    );
    if (choice) resumeInTerminal(sessionId);
    return;
  }
  // The Claude Code extension resolves sessions against the open workspace
  // folder. If this session belongs to a different project, the in-extension
  // open fails with "No conversation found". Detect the mismatch up front and
  // fall back to the terminal, which launches in the session's own cwd.
  const session = loadSessionById(sessionId);
  const workspaceCwd = getWorkspaceCwd();
  if (session?.cwd && workspaceCwd && !sameCwd(session.cwd, workspaceCwd)) {
    const choice = await vscode.window.showWarningMessage(
      `This session belongs to a different folder (${session.cwd}). ` +
        `The Claude Code extension can only resume sessions from the open workspace. ` +
        `Open in terminal instead?`,
      'Open in Terminal'
    );
    if (choice) resumeInTerminal(sessionId);
    return;
  }
  try {
    // claude-vscode.editor.open(sessionId, initialPrompt?, viewColumn?)
    await vscode.commands.executeCommand(
      'claude-vscode.editor.open',
      sessionId,
      undefined,
      vscode.ViewColumn.Active
    );
  } catch (e) {
    const choice = await vscode.window.showErrorMessage(
      `Failed to open in Claude Code extension: ${e}. Open in terminal instead?`,
      'Open in Terminal'
    );
    if (choice) resumeInTerminal(sessionId);
  }
}

// Start a brand-new session (not a fork) but record it as a manual child of
// the given parent so it nests under the parent in the tree. We can't know the
// new session id up front (Claude assigns it), so we snapshot the current ids
// and link whichever new id appears next (see resolvePendingChildren).
async function newChildSession(parentId: string): Promise<void> {
  const parent = loadSessionById(parentId);
  const cwd = parent?.cwd && fs.existsSync(parent.cwd) ? parent.cwd : getWorkspaceCwd() ?? undefined;

  const config = vscode.workspace.getConfiguration('agentChatTree');
  let target = config.get<string>('resumeTarget', 'ask');
  if (target === 'ask') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(terminal) Terminal', description: 'Start claude in an integrated terminal', value: 'terminal' },
        { label: '$(window) Claude Code Extension', description: 'Start in a Claude Code editor tab', value: 'extension' },
      ],
      { placeHolder: 'Start the new child session in…' }
    );
    if (!pick) return;
    target = pick.value;
  }

  // Snapshot existing scoped session ids so the next new one can be attributed.
  const knownIds = currentScopedSessionIds();
  await addPendingChild(parentId, knownIds);

  if (target === 'extension' && vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    try {
      await vscode.commands.executeCommand('claude-vscode.newConversation');
    } catch {
      startNewSessionInTerminal(cwd);
    }
  } else {
    startNewSessionInTerminal(cwd);
  }

  vscode.window.showInformationMessage(
    'New child session starting. It will appear under its parent once the first message is recorded.'
  );
  treeProvider?.refresh();
}

function startNewSessionInTerminal(cwd?: string): void {
  const term = vscode.window.createTerminal({ name: 'Claude: new', cwd });
  term.show();
  term.sendText('claude');
}

// Delete a session's log file after confirmation, and drop any manual-parent
// links that reference it (as child or as parent).
async function deleteSession(sessionId: string): Promise<boolean> {
  const session = loadSessionById(sessionId);
  if (!session) {
    vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
    return false;
  }
  const title = session.turns.find(t => t.type === 'user' && t.text.trim())?.text.trim().slice(0, 60)
    ?? sessionId.slice(0, 8);

  const confirm = await vscode.window.showWarningMessage(
    `Delete this session permanently?\n\n"${title}"`,
    { modal: true, detail: session.filePath },
    'Delete'
  );
  if (confirm !== 'Delete') return false;

  try {
    fs.unlinkSync(session.filePath);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to delete session: ${e}`);
    return false;
  }

  // Clean up manual links: remove the deleted id as a child, and detach any
  // children that pointed to it as their parent.
  const map = getManualParents();
  let changed = false;
  if (map[sessionId]) {
    delete map[sessionId];
    changed = true;
  }
  for (const [child, parent] of Object.entries(map)) {
    if (parent === sessionId) {
      delete map[child];
      changed = true;
    }
  }
  if (changed) {
    await extContext.globalState.update(MANUAL_PARENTS_KEY, map);
  }

  treeProvider?.refresh();
  vscode.window.showInformationMessage('Session deleted.');
  return true;
}

// Ids of all sessions currently in scope (used for pending-child snapshots).
function currentScopedSessionIds(): string[] {
  const projectsDir = getProjectsDir();
  const { onlyDir } = getScanScope();
  return listSessionFiles(projectsDir, onlyDir).map(f => path.basename(f, '.jsonl'));
}

// Prompt for a keyword and put the sidebar into search mode, which lists
// matching sessions and their matching prompts with the keyword highlighted.
async function searchPrompts(): Promise<void> {
  const keyword = await vscode.window.showInputBox({
    placeHolder: 'Search user prompts in this workspace…',
    prompt: 'Find a keyword across the user messages of every session',
    value: '',
  });
  if (keyword === undefined) return; // cancelled
  const trimmed = keyword.trim();
  treeProvider?.setSearch(trimmed || null);
  await vscode.commands.executeCommand('setContext', 'agentChatTree.searching', !!trimmed);
  if (trimmed) {
    // Focus the sidebar view (auto-generated `<viewId>.focus` command).
    vscode.commands.executeCommand('agentChatTreeSidebar.focus');
  }
}

// Descendant sessions (forks + manual children, recursively) of a given
// session, for the webview's "Child sessions" section. Returns a nested tree
// so child-of-child relationships are shown.
function childSessionsOf(parentId: string) {
  const { summaries, parentOf, relationOf } = loadSessionGraph();

  const byId = new Map(summaries.map(s => [s.id, s]));
  const childrenOf = new Map<string, SessionSummary[]>();
  for (const s of summaries) {
    const parent = parentOf.get(s.id);
    if (parent && byId.has(parent)) {
      const arr = childrenOf.get(parent) ?? [];
      arr.push(s);
      childrenOf.set(parent, arr);
    }
  }

  const build = (id: string, seen: Set<string>): ChildSessionRef[] =>
    (childrenOf.get(id) ?? []).map(s => {
      // Guard against cycles from manual links.
      const childSeen = new Set(seen).add(s.id);
      return {
        id: s.id,
        title: s.firstPrompt || s.projectName || s.id,
        relation: relationOf.get(s.id) ?? 'fork',
        turnCount: s.turnCount,
        tokensK: ((s.totalInputTokens + s.totalOutputTokens) / 1000).toFixed(1),
        children: seen.has(s.id) ? [] : build(s.id, childSeen),
      };
    });

  return build(parentId, new Set([parentId]));
}

// Parse a single session by id, scoped the same way as the list.
function loadSessionById(sessionId: string): Session | null {
  const projectsDir = getProjectsDir();
  const { onlyDir } = getScanScope();
  const files = listSessionFiles(projectsDir, onlyDir);
  const filePath = files.find(f => path.basename(f, '.jsonl') === sessionId);
  if (!filePath) return null;
  try {
    return parseSession(filePath);
  } catch {
    return null;
  }
}

// Current workspace root path, or null if no folder is open.
function getWorkspaceCwd(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function sameCwd(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

// When workspaceOnly is on, restrict scanning to the project dir matching the
// open workspace. Returns the dir to scan (or null to scan everything), plus
// the cwd to verify each session against.
function getScanScope(): { onlyDir: string | undefined; cwd: string | null } {
  if (!isWorkspaceOnly()) return { onlyDir: undefined, cwd: null };
  const cwd = getWorkspaceCwd();
  if (!cwd) return { onlyDir: undefined, cwd: null };
  const dir = findProjectDirForCwd(getProjectsDir(), cwd);
  // dir may be null if the encoded name doesn't match; fall back to scanning
  // all dirs and filtering by the cwd field.
  return { onlyDir: dir ?? undefined, cwd };
}

function loadSessions(maxCount: number): SessionSummary[] {
  const projectsDir = getProjectsDir();
  const { onlyDir, cwd } = getScanScope();
  const files = listSessionFiles(projectsDir, onlyDir);

  const summaries: SessionSummary[] = [];
  for (const f of files) {
    try {
      const session = parseSession(f);
      if (cwd && session.cwd && !sameCwd(session.cwd, cwd)) continue;
      summaries.push(sessionToSummary(session));
      if (summaries.length >= maxCount) break;
    } catch {
      // skip unparseable
    }
  }
  return summaries;
}

// Parse all scoped sessions and derive the parent graph (fork links plus
// manually-declared child links). Used by the sidebar tree to nest sessions.
function loadSessionGraph(): {
  summaries: SessionSummary[];
  parentOf: Map<string, string>;
  relationOf: Map<string, 'fork' | 'manual'>;
  stats: { todayTokens: number; totalTokens: number; sessionCount: number };
} {
  const projectsDir = getProjectsDir();
  const { onlyDir, cwd } = getScanScope();
  const files = listSessionFiles(projectsDir, onlyDir);

  const sessions = [];
  for (const f of files) {
    try {
      const session = parseSession(f);
      if (cwd && session.cwd && !sameCwd(session.cwd, cwd)) continue;
      sessions.push(session);
    } catch {
      // skip unparseable
    }
  }

  // Fork graph computed over all scoped sessions before capping the count.
  const parentOf = buildForkGraph(sessions);
  const relationOf = new Map<string, 'fork' | 'manual'>();
  for (const childId of parentOf.keys()) relationOf.set(childId, 'fork');

  // Resolve any pending new-child creations against the live id set, then
  // overlay manual parent links (manual wins over an inferred fork link).
  const manual = resolvePendingChildren(sessions.map(s => s.id));
  for (const [childId, parentId] of Object.entries(manual)) {
    parentOf.set(childId, parentId);
    relationOf.set(childId, 'manual');
  }

  // Token stats: total across the workspace, plus the subset spent today.
  const today = new Date().toDateString();
  let todayTokens = 0;
  let totalTokens = 0;
  for (const s of sessions) {
    for (const t of s.turns) {
      const tok = t.inputTokens + t.outputTokens;
      if (tok === 0) continue;
      totalTokens += tok;
      if (t.timestamp && new Date(t.timestamp).toDateString() === today) {
        todayTokens += tok;
      }
    }
  }

  const summaries = sessions.slice(0, getMaxSessions()).map(sessionToSummary);
  return {
    summaries,
    parentOf,
    relationOf,
    stats: { todayTokens, totalTokens, sessionCount: sessions.length },
  };
}

function openBrowserPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    refreshPanel(context);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'agentChatTree',
    'Agent Chat Tree',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  panel.onDidDispose(() => {
    panel = undefined;
    watcher?.dispose();
    watcher = undefined;
  });

  panel.webview.onDidReceiveMessage(msg => {
    handleWebviewMessage(context, msg);
  });

  const config = vscode.workspace.getConfiguration('agentChatTree');
  const maxSessions = config.get<number>('maxSessions', 50);

  cachedSessions = loadSessions(maxSessions);
  panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
    view: 'browser',
    sessions: cachedSessions,
  });

  // Watch for new/changed sessions. In workspace-only mode the jsonl files
  // live in a single project dir, so watch that directly; otherwise watch the
  // projects root.
  const { onlyDir } = getScanScope();
  const watchTarget = onlyDir ?? getProjectsDir();
  watcher = new SessionWatcher((changedFile) => {
    if (panel) {
      cachedSessions = loadSessions(maxSessions);
      panel.webview.postMessage({
        command: 'updateSessions',
        sessions: cachedSessions,
      });
    }
  });
  watcher.watchDir(watchTarget);

  context.subscriptions.push({ dispose: () => watcher?.dispose() });
}

function openSessionPanel(context: vscode.ExtensionContext, sessionId: string) {
  const projectsDir = getProjectsDir();
  const files = listSessionFiles(projectsDir);
  const filePath = files.find(f => path.basename(f, '.jsonl') === sessionId);

  if (!filePath) {
    vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
    return;
  }

  try {
    const session = parseSession(filePath);
    const children = childSessionsOf(sessionId);
    if (panel) {
      panel.reveal();
      panel.title = `Session: ${session.projectName}`;
      panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
        view: 'session',
        session,
        children,
      });
    } else {
      panel = vscode.window.createWebviewPanel(
        'agentChatTree',
        `Session: ${session.projectName}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.onDidDispose(() => { panel = undefined; });
      panel.webview.onDidReceiveMessage(msg => handleWebviewMessage(context, msg));
      panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
        view: 'session',
        session,
        children,
      });
    }

    // Watch this session file for live updates
    watcher?.dispose();
    watcher = new SessionWatcher(() => {
      try {
        const updated = parseSession(filePath);
        panel?.webview.postMessage({
          command: 'updateSession',
          session: updated,
          children: childSessionsOf(sessionId),
        });
      } catch { /* ignore */ }
    });
    watcher.watch(filePath);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to parse session: ${e}`);
  }
}

function refreshPanel(context: vscode.ExtensionContext) {
  if (!panel) return;
  const config = vscode.workspace.getConfiguration('agentChatTree');
  const maxSessions = config.get<number>('maxSessions', 50);
  cachedSessions = loadSessions(maxSessions);
  panel.webview.postMessage({ command: 'updateSessions', sessions: cachedSessions });
}

function handleWebviewMessage(
  context: vscode.ExtensionContext,
  msg: { command: string; sessionId?: string; filePath?: string }
) {
  switch (msg.command) {
    case 'openSession':
      if (msg.sessionId) {
        openSessionPanel(context, msg.sessionId);
      }
      break;

    case 'openFile':
      if (msg.filePath && fs.existsSync(msg.filePath)) {
        vscode.window.showTextDocument(vscode.Uri.file(msg.filePath));
      }
      break;

    case 'goBack':
      openBrowserPanel(context);
      break;

    case 'deleteSession':
      if (msg.sessionId) {
        const id = msg.sessionId;
        deleteSession(id).then(ok => {
          if (ok && panel) openBrowserPanel(context);
        });
      }
      break;

    case 'refresh':
      refreshPanel(context);
      break;
  }
}

export function deactivate() {
  watcher?.dispose();
  sidebarWatcher?.dispose();
}
