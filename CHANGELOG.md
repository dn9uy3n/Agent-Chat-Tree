# Changelog

## 0.2.0

- Sidebar tree view scoped to the current workspace.
- Automatic fork detection (via `logicalParentUuid`) — forks nested under their origin.
- Manual child sessions: start a new session linked under any parent.
- Resume a session in an integrated terminal or the Claude Code extension.
- Webview tree view with a recursive child-session panel (child-of-child).
- In-sidebar prompt search with keyword highlighting and auto-expanded results.
- Delete sessions with confirmation.
- Session titles taken from the first user prompt.

## 0.1.0

- Initial release.
- Session browser listing recent Claude Code sessions across all projects.
- Conversation tree view: user/assistant turns, tool calls, token counts.
- Live file-watcher updates.
- Search sessions by project name or working directory.
