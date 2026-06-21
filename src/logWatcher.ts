import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Session, Turn, ToolCall } from './sessionTree';

interface RawEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: RawContent[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

interface RawContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export function getClaudeProjectsDir(configuredPath?: string): string {
  if (configuredPath) return configuredPath;
  return path.join(os.homedir(), '.claude', 'projects');
}

// Claude Code names each project directory by encoding the cwd: every
// non-alphanumeric character becomes a dash. e.g.
//   c:\Users\Deus\...\Agent-Chat-Tree -> c--Users-Deus-...-Agent-Chat-Tree
export function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// Locate the project directory matching a workspace cwd (case-insensitive,
// since drive-letter / path casing can differ). Returns null if none.
export function findProjectDirForCwd(projectsDir: string, cwd: string): string | null {
  if (!fs.existsSync(projectsDir)) return null;
  const target = encodeProjectDirName(cwd).toLowerCase();
  const match = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .find(d => d.name.toLowerCase() === target);
  return match ? path.join(projectsDir, match.name) : null;
}

export function listSessionFiles(projectsDir: string, onlyDir?: string): string[] {
  if (!fs.existsSync(projectsDir)) return [];

  let projectDirs: string[];
  if (onlyDir) {
    projectDirs = fs.existsSync(onlyDir) ? [onlyDir] : [];
  } else {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projectsDir, d.name));
  }

  const files: string[] = [];
  for (const pDir of projectDirs) {
    try {
      const jsonlFiles = fs.readdirSync(pDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(pDir, f));
      files.push(...jsonlFiles);
    } catch {
      // skip unreadable dirs
    }
  }

  return files.sort((a, b) => {
    const statA = fs.statSync(a).mtime.getTime();
    const statB = fs.statSync(b).mtime.getTime();
    return statB - statA;
  });
}

function extractText(content: RawContent[]): string {
  return content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('\n')
    .trim();
}

function extractToolCalls(content: RawContent[]): ToolCall[] {
  return content
    .filter(c => c.type === 'tool_use' && c.id && c.name)
    .map(c => ({
      id: c.id!,
      name: c.name!,
      input: c.input ?? {},
    }));
}

export function parseSession(filePath: string): Session {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());

  const entries: RawEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }

  const sessionId = path.basename(filePath, '.jsonl');
  const projectDir = path.basename(path.dirname(filePath));
  const projectName = projectDir
    .replace(/^c--/, '')
    .replace(/--/g, '/')
    .replace(/-/g, ' ')
    .replace(/\//g, ' › ');

  let cwd = '';
  let model = '';
  const turns: Turn[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const messageUuids: string[] = [];
  const logicalParentUuids: string[] = [];

  // Collect metadata from first user entry
  const firstEntry = entries.find(e => e.cwd);
  if (firstEntry?.cwd) cwd = firstEntry.cwd;

  // Collect every entry uuid + any fork-link references, regardless of type.
  for (const entry of entries) {
    if (entry.uuid) messageUuids.push(entry.uuid);
    if (entry.logicalParentUuid) logicalParentUuids.push(entry.logicalParentUuid);
  }

  // Track seen assistant message IDs to deduplicate streaming chunks
  const seenAssistantMsgIds = new Set<string>();

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (!entry.message || !entry.uuid) continue;

    const msg = entry.message;
    const role = msg.role;
    const content: RawContent[] = Array.isArray(msg.content) ? msg.content : [];

    if (role === 'user') {
      const text = extractText(content);
      if (!text) continue;

      turns.push({
        uuid: entry.uuid,
        parentUuid: entry.parentUuid ?? null,
        type: 'user',
        timestamp: entry.timestamp ?? '',
        text,
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
      });
    } else if (role === 'assistant') {
      // JSONL has multiple entries per assistant "message" (streaming chunks share same msg id)
      // Use entry uuid (unique per line) but deduplicate by aggregating tool calls + text
      const inputTok = msg.usage?.input_tokens ?? 0;
      const outputTok = msg.usage?.output_tokens ?? 0;
      const text = extractText(content);
      const toolCalls = extractToolCalls(content);

      if (msg.model) model = msg.model;

      // Each assistant entry in JSONL is its own node (they chain via parentUuid)
      // Only add if it has meaningful content
      if (text || toolCalls.length > 0) {
        totalInputTokens += inputTok;
        totalOutputTokens += outputTok;

        turns.push({
          uuid: entry.uuid,
          parentUuid: entry.parentUuid ?? null,
          type: 'assistant',
          timestamp: entry.timestamp ?? '',
          text,
          toolCalls,
          inputTokens: inputTok,
          outputTokens: outputTok,
        });
      }
    }
  }

  const timestamps = turns.map(t => t.timestamp).filter(Boolean).sort();
  const startTime = timestamps[0] ?? '';
  const endTime = timestamps[timestamps.length - 1] ?? '';

  return {
    id: sessionId,
    projectDir,
    projectName,
    filePath,
    startTime,
    endTime,
    turns,
    cwd,
    model,
    totalInputTokens,
    totalOutputTokens,
    messageUuids,
    logicalParentUuids,
  };
}

// Build the fork graph: map each session id to its fork-parent session id.
// A session B is forked from A when B's root system entry carries a
// logicalParentUuid that resolves to a message uuid owned by A (A != B).
export function buildForkGraph(sessions: Session[]): Map<string, string> {
  const uuidToSession = new Map<string, string>();
  for (const s of sessions) {
    for (const uuid of s.messageUuids) {
      // First writer wins; a uuid belongs to the session that produced it.
      if (!uuidToSession.has(uuid)) uuidToSession.set(uuid, s.id);
    }
  }

  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    for (const lpu of s.logicalParentUuids) {
      const owner = uuidToSession.get(lpu);
      if (owner && owner !== s.id) {
        parentOf.set(s.id, owner);
        break;
      }
    }
  }
  return parentOf;
}

export class SessionWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private onChange: (filePath: string) => void;

  constructor(onChange: (filePath: string) => void) {
    this.onChange = onChange;
  }

  watch(filePath: string): void {
    if (this.watchers.has(filePath)) return;

    try {
      const watcher = fs.watch(filePath, () => {
        this.onChange(filePath);
      });
      this.watchers.set(filePath, watcher);
    } catch {
      // file may not exist yet
    }
  }

  watchDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;

    try {
      const watcher = fs.watch(dirPath, (event, filename) => {
        if (filename?.endsWith('.jsonl')) {
          this.onChange(path.join(dirPath, filename));
        }
      });
      this.watchers.set(dirPath, watcher);
    } catch {
      // skip
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
