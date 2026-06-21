import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { Session, SessionSummary } from './sessionTree';

interface BrowserViewData {
  view: 'browser';
  sessions: SessionSummary[];
}

export interface ChildSessionRef {
  id: string;
  title: string;
  relation: 'fork' | 'manual';
  turnCount: number;
  tokensK: string;
  children: ChildSessionRef[];
}

interface SessionViewData {
  view: 'session';
  session: Session;
  children: ChildSessionRef[];
}

type ViewData = BrowserViewData | SessionViewData;

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  data: ViewData
): string {
  const nonce = getNonce();
  // Escape sequences that could break out of the inline <script> context.
  // A </script> or U+2028/U+2029 inside session content would otherwise
  // terminate the script tag or the JS string literal.
  const dataJson = escapeForInlineScript(JSON.stringify(data));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Chat Tree</title>
  <style nonce="${nonce}">${getStyles()}</style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialData = ${dataJson};
    ${getScript()}
  </script>
</body>
</html>`;
}

function getNonce(): string {
  // Cryptographically strong nonce. Math.random() is predictable and could
  // let an attacker craft a script tag that satisfies the CSP nonce.
  return randomBytes(16).toString('base64');
}

// Neutralize sequences that could escape the inline <script> JSON payload:
//   </script>   -> would terminate the script element
//   U+2028/U+2029 -> are line terminators that break the inline JS string
// Built with String.fromCharCode so the source has no raw control chars.
function escapeForInlineScript(json: string): string {
  const LT = String.fromCharCode(0x3c); // <
  const GT = String.fromCharCode(0x3e); // >
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return json
    .split(LT).join('\\u003c')
    .split(GT).join('\\u003e')
    .split(LS).join('\\u2028')
    .split(PS).join('\\u2029');
}

function getStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-titleBar-activeBackground, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar h1 {
      font-size: 13px;
      font-weight: 600;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-titleBar-activeForeground, var(--vscode-foreground));
    }
    .btn {
      cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      font-size: 12px;
      flex-shrink: 0;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger {
      background: transparent;
      color: var(--vscode-errorForeground, #f48771);
      border: 1px solid var(--vscode-errorForeground, #f48771);
    }
    .btn-danger:hover {
      background: var(--vscode-errorForeground, #f48771);
      color: var(--vscode-editor-background);
    }

    /* Main layout */
    #root { display: flex; flex-direction: column; height: 100vh; }
    .content { flex: 1; overflow: auto; padding: 12px; }

    /* Session browser */
    .session-list { display: flex; flex-direction: column; gap: 6px; }
    .session-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px 12px;
      cursor: pointer;
      transition: background 0.1s;
      background: var(--vscode-editor-background);
    }
    .session-card:hover { background: var(--vscode-list-hoverBackground); }
    .session-card .project-name {
      font-weight: 600;
      font-size: 13px;
      color: var(--vscode-textLink-foreground);
      margin-bottom: 4px;
    }
    .session-card .meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .session-card .meta span { white-space: nowrap; }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
      font-weight: 600;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* Chat tree */
    .tree { list-style: none; padding: 0; }
    .tree-node { margin: 4px 0; }

    .turn {
      display: flex;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 4px;
      border-left: 3px solid transparent;
      transition: background 0.1s;
    }
    .turn:hover { background: var(--vscode-list-hoverBackground); }
    .turn.user { border-left-color: var(--vscode-textLink-foreground, #4fc3f7); }
    .turn.assistant { border-left-color: var(--vscode-charts-green, #66bb6a); }

    .turn-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .turn.user .turn-icon { background: var(--vscode-textLink-foreground, #4fc3f7); color: #000; }
    .turn.assistant .turn-icon { background: var(--vscode-charts-green, #66bb6a); color: #000; }

    .turn-body { flex: 1; min-width: 0; }
    .turn-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }
    .turn-role {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
    }
    .turn-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .turn-tokens {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }
    .turn-text {
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow: hidden;
      position: relative;
    }
    .turn-text.expanded { max-height: none; }
    .turn-text::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 40px;
      background: linear-gradient(transparent, var(--vscode-editor-background));
      pointer-events: none;
    }
    .turn-text.expanded::after { display: none; }

    .expand-btn {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font-size: 11px;
      padding: 2px 0;
      margin-top: 2px;
    }
    .expand-btn:hover { text-decoration: underline; }

    /* Tool calls */
    .tool-calls {
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .tool-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      width: fit-content;
      cursor: pointer;
    }
    .tool-chip:hover { opacity: 0.8; }
    .tool-chip .tool-name { font-weight: 600; }
    .tool-input-preview {
      display: none;
      margin-top: 4px;
      padding: 6px 8px;
      border-radius: 3px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 2px solid var(--vscode-charts-yellow, #ffa726);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 150px;
      overflow: auto;
    }
    .tool-input-preview.visible { display: block; }

    /* Thread connector lines */
    .tree-children {
      margin-left: 28px;
      padding-left: 12px;
      border-left: 1px dashed var(--vscode-panel-border);
    }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .empty h2 { margin-bottom: 8px; font-size: 16px; }
    .empty p { font-size: 12px; line-height: 1.6; }

    /* Stats bar */
    .stats-bar {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      padding: 8px 12px;
      background: var(--vscode-textBlockQuote-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }
    .stats-bar strong { color: var(--vscode-foreground); }

    /* Search */
    .search-bar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .search-input {
      width: 100%;
      padding: 5px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 3px;
      font-size: 12px;
      outline: none;
    }
    .search-input:focus { border-color: var(--vscode-focusBorder); }

    /* Child sessions panel */
    .child-sessions {
      margin: 8px 12px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }
    .child-sessions-head {
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .child-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .child-row:hover { background: var(--vscode-list-hoverBackground); }
    .child-connector {
      flex-shrink: 0;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      margin-right: 2px;
    }
    .child-mark {
      flex-shrink: 0;
      width: 16px;
      text-align: center;
      font-weight: 700;
    }
    .child-mark.fork { color: var(--vscode-charts-yellow, #ffa726); }
    .child-mark.manual { color: var(--vscode-charts-green, #66bb6a); }
    .child-title {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .child-meta {
      flex-shrink: 0;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .hidden { display: none !important; }
  `;
}

function getScript(): string {
  return `
    // State
    let state = initialData;

    // Safe DOM helpers. All user-supplied strings go through textContent,
    // never innerHTML interpolation.
    function setText(node, str) {
      node.textContent = str != null ? String(str) : '';
    }

    function el(tag, cls) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    function render() {
      const root = document.getElementById('root');
      root.innerHTML = '';
      if (state.view === 'browser') {
        root.appendChild(buildBrowser(state.sessions));
      } else {
        root.appendChild(buildSession(state.session, state.children || []));
      }
    }

    // Browser view
    function buildBrowser(sessions) {
      const wrap = el('div');
      wrap.innerHTML =
        '<div class="toolbar"><h1>Agent Chat Tree</h1>' +
        '<button class="btn btn-secondary" id="refresh-btn">Refresh</button></div>' +
        '<div class="search-bar"><input class="search-input" id="search" type="text" placeholder="Search by project name or cwd..." /></div>' +
        '<div class="stats-bar"><span id="session-count"></span></div>' +
        '<div class="content"><div class="session-list" id="session-list"></div></div>';

      wrap.querySelector('#refresh-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'refresh' });
      });
      wrap.querySelector('#search').addEventListener('input', filterSessions);

      wrap.querySelector('#session-count').textContent = sessions.length + ' sessions';

      const list = wrap.querySelector('#session-list');
      if (sessions.length === 0) {
        list.innerHTML =
          '<div class="empty"><h2>No sessions found</h2>' +
          '<p>Claude Code sessions are stored in<br><code>~/.claude/projects/</code><br>Run Claude Code to create sessions.</p></div>';
      } else {
        sessions.forEach(s => list.appendChild(buildSessionCard(s)));
      }
      return wrap;
    }

    function buildSessionCard(s) {
      const card = el('div', 'session-card');
      card.dataset.id = s.id || '';

      const nameEl = el('div', 'project-name');
      setText(nameEl, s.firstPrompt || s.projectName);
      card.appendChild(nameEl);

      const meta = el('div', 'meta');
      const date = s.startTime ? new Date(s.startTime).toLocaleString() : 'Unknown';
      const tokens = ((s.totalInputTokens + s.totalOutputTokens) / 1000).toFixed(1);

      const projSpan = el('span'); setText(projSpan, s.projectName);
      const dateSpan = el('span'); setText(dateSpan, date);
      const turnSpan = el('span'); setText(turnSpan, s.turnCount + ' exchanges');
      const tokSpan  = el('span'); setText(tokSpan,  tokens + 'k tokens');
      meta.append(projSpan, dateSpan, turnSpan, tokSpan);

      if (s.model) {
        const badge = el('span', 'badge');
        setText(badge, s.model.replace('claude-', ''));
        meta.appendChild(badge);
      }
      card.appendChild(meta);

      if (s.cwd) {
        const cwdRow = el('div', 'meta');
        cwdRow.style.marginTop = '3px';
        const cwdSpan = el('span');
        setText(cwdSpan, s.cwd);
        cwdRow.appendChild(cwdSpan);
        card.appendChild(cwdRow);
      }

      card.dataset.project = s.projectName || '';
      card.dataset.cwd = s.cwd || '';

      card.addEventListener('click', () => {
        vscode.postMessage({ command: 'openSession', sessionId: card.dataset.id });
      });

      return card;
    }

    function filterSessions() {
      const q = document.getElementById('search').value.toLowerCase();
      document.querySelectorAll('.session-card').forEach(card => {
        const project = (card.dataset.project || '').toLowerCase();
        const cwd = (card.dataset.cwd || '').toLowerCase();
        card.classList.toggle('hidden', !!(q && !project.includes(q) && !cwd.includes(q)));
      });
    }

    // Session view
    function buildSession(session, children) {
      const wrap = el('div');
      wrap.innerHTML =
        '<div class="toolbar">' +
        '<button class="btn btn-secondary" id="back-btn">Back</button>' +
        '<h1 id="sess-title"></h1>' +
        '<button class="btn btn-danger" id="delete-btn">Delete</button></div>' +
        '<div class="stats-bar" id="sess-stats"></div>' +
        '<div id="sess-children"></div>' +
        '<div class="content" id="sess-content"></div>';

      wrap.querySelector('#back-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'goBack' });
      });
      wrap.querySelector('#delete-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'deleteSession', sessionId: session.id });
      });

      setText(wrap.querySelector('#sess-title'), session.projectName);

      if (children && children.length > 0) {
        wrap.querySelector('#sess-children').appendChild(buildChildSessions(children));
      }

      const statsBar = wrap.querySelector('#sess-stats');
      const totalTokens = ((session.totalInputTokens + session.totalOutputTokens) / 1000).toFixed(1);
      const userTurns = session.turns.filter(t => t.type === 'user').length;
      const date = session.startTime ? new Date(session.startTime).toLocaleDateString() : '';

      [
        date,
        userTurns + ' exchanges',
        totalTokens + 'k tokens',
      ].forEach(txt => {
        const s = el('span'); setText(s, txt); statsBar.appendChild(s);
      });
      if (session.model) {
        const badge = el('span', 'badge');
        setText(badge, session.model.replace('claude-', ''));
        statsBar.appendChild(badge);
      }
      if (session.cwd) {
        const s = el('span'); setText(s, session.cwd); statsBar.appendChild(s);
      }

      const content = wrap.querySelector('#sess-content');
      if (session.turns.length === 0) {
        content.innerHTML = '<div class="empty"><h2>No messages</h2><p>This session appears empty.</p></div>';
      } else {
        const tree = el('ul', 'tree');
        buildTurnList(session.turns, null, tree);
        content.appendChild(tree);
      }

      return wrap;
    }

    // Child sessions panel (forks + manually-linked children, nested so
    // child-of-child relationships are shown).
    function countDescendants(nodes) {
      let n = 0;
      nodes.forEach(c => { n += 1 + countDescendants(c.children || []); });
      return n;
    }

    function buildChildRows(nodes, depth, container) {
      nodes.forEach(c => {
        const row = el('div', 'child-row');
        row.style.paddingLeft = (10 + depth * 16) + 'px';

        if (depth > 0) {
          const connector = el('span', 'child-connector');
          connector.textContent = '└─';
          row.appendChild(connector);
        }
        const mark = el('span', 'child-mark ' + c.relation);
        mark.textContent = c.relation === 'manual' ? '↳' : '⑂';
        const title = el('span', 'child-title');
        setText(title, c.title);
        const meta = el('span', 'child-meta');
        setText(meta, c.turnCount + ' msgs · ' + c.tokensK + 'k');
        row.append(mark, title, meta);
        row.title = (c.relation === 'manual' ? 'Manual child' : 'Forked') + ' — open tree view';
        row.addEventListener('click', () => {
          vscode.postMessage({ command: 'openSession', sessionId: c.id });
        });
        container.appendChild(row);

        if (c.children && c.children.length > 0) {
          buildChildRows(c.children, depth + 1, container);
        }
      });
    }

    function buildChildSessions(children) {
      const box = el('div', 'child-sessions');
      const head = el('div', 'child-sessions-head');
      setText(head, 'Child sessions (' + countDescendants(children) + ')');
      box.appendChild(head);
      buildChildRows(children, 0, box);
      return box;
    }

    function buildTurnList(turns, parentUuid, container) {
      const children = turns.filter(t => t.parentUuid === parentUuid);
      children.forEach(turn => {
        const li = el('li', 'tree-node');
        li.appendChild(buildTurn(turn));

        const grandchildren = turns.filter(t => t.parentUuid === turn.uuid);
        if (grandchildren.length > 0) {
          const subTree = el('ul', 'tree tree-children');
          buildTurnList(turns, turn.uuid, subTree);
          li.appendChild(subTree);
        }
        container.appendChild(li);
      });
    }

    function buildTurn(turn) {
      const div = el('div', 'turn ' + turn.type);

      const icon = el('div', 'turn-icon');
      icon.textContent = turn.type === 'user' ? 'U' : 'A';
      div.appendChild(icon);

      const body = el('div', 'turn-body');

      const header = el('div', 'turn-header');
      const roleEl = el('span', 'turn-role');
      setText(roleEl, turn.type === 'user' ? 'User' : 'Assistant');
      const timeEl = el('span', 'turn-time');
      setText(timeEl, turn.timestamp ? new Date(turn.timestamp).toLocaleTimeString() : '');
      header.append(roleEl, timeEl);

      if (turn.inputTokens || turn.outputTokens) {
        const tok = el('span', 'turn-tokens');
        setText(tok, 'in:' + turn.inputTokens + ' out:' + turn.outputTokens);
        header.appendChild(tok);
      }
      body.appendChild(header);

      if (turn.text) {
        const textDiv = el('div', 'turn-text' + (turn.text.length > 300 ? '' : ' expanded'));
        textDiv.textContent = turn.text;
        body.appendChild(textDiv);

        if (turn.text.length > 300) {
          const btn = el('button', 'expand-btn');
          btn.textContent = 'Show more';
          btn.addEventListener('click', () => {
            textDiv.classList.toggle('expanded');
            btn.textContent = textDiv.classList.contains('expanded') ? 'Show less' : 'Show more';
          });
          body.appendChild(btn);
        }
      }

      if (turn.toolCalls && turn.toolCalls.length > 0) {
        body.appendChild(buildToolCalls(turn.toolCalls));
      }

      div.appendChild(body);
      return div;
    }

    function buildToolCalls(toolCalls) {
      const wrap = el('div', 'tool-calls');
      toolCalls.forEach(tc => {
        const row = el('div');

        const chip = el('span', 'tool-chip');
        const nameEl = el('span', 'tool-name');
        setText(nameEl, tc.name);
        chip.appendChild(nameEl);

        const preview = el('div', 'tool-input-preview');
        preview.textContent = JSON.stringify(tc.input, null, 2);

        chip.addEventListener('click', () => preview.classList.toggle('visible'));

        row.append(chip, preview);
        wrap.appendChild(row);
      });
      return wrap;
    }

    // Live updates
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'updateSessions') {
        state = { view: 'browser', sessions: msg.sessions };
        render();
      } else if (msg.command === 'updateSession') {
        state = { view: 'session', session: msg.session, children: msg.children || [] };
        render();
      }
    });

    render();
  `;
}
