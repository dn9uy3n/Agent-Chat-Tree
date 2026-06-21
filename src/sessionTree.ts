export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Turn {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant';
  timestamp: string;
  text: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}

export interface Session {
  id: string;
  projectDir: string;
  projectName: string;
  filePath: string;
  startTime: string;
  endTime: string;
  turns: Turn[];
  cwd: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  // All entry uuids in this file (used to resolve cross-session fork links).
  messageUuids: string[];
  // logicalParentUuid values from root system entries; if one resolves to a
  // uuid in a different session, that session is this session's fork parent.
  logicalParentUuids: string[];
}

export interface SessionSummary {
  id: string;
  projectName: string;
  firstPrompt: string;
  filePath: string;
  startTime: string;
  endTime: string;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cwd: string;
  model: string;
}

// First user message, collapsed to a single line. Used as the session title.
function firstUserPrompt(s: Session): string {
  const first = s.turns.find(t => t.type === 'user' && t.text.trim());
  if (!first) return '';
  const oneLine = first.text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 100 ? oneLine.slice(0, 100) + '…' : oneLine;
}

export function sessionToSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    projectName: s.projectName,
    firstPrompt: firstUserPrompt(s),
    filePath: s.filePath,
    startTime: s.startTime,
    endTime: s.endTime,
    turnCount: s.turns.filter(t => t.type === 'user').length,
    totalInputTokens: s.totalInputTokens,
    totalOutputTokens: s.totalOutputTokens,
    cwd: s.cwd,
    model: s.model,
  };
}
