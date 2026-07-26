import { randomBytes } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

interface ChatGptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface ChatGptCodexTransfer {
  id?: string;
  title?: string;
  sourceUrl?: string;
  history?: string;
  messages?: ChatGptMessage[];
  cwd?: string;
}

export interface CreatedCodexTask {
  threadId: string;
  title: string;
  cwd: string;
  rolloutPath: string;
}

const CODEX_DIR = join(homedir(), '.codex');
const CODEX_SESSIONS_DIR = join(CODEX_DIR, 'sessions');
const CODEX_SESSION_INDEX = join(CODEX_DIR, 'session_index.jsonl');
const CODEX_THREADS_DB = join(CODEX_DIR, 'state_5.sqlite');
const FALLBACK_WORKSPACE = join(homedir(), '.attune', 'chatgpt-imports');

function uuidV7(): string {
  const timestampHex = Date.now().toString(16).padStart(12, '0');
  const random = randomBytes(10);
  random[0] = (random[0] & 0x0f) | 0x70;
  random[2] = (random[2] & 0x3f) | 0x80;
  const randomHex = random.toString('hex');
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8, 12)}-${randomHex.slice(0, 4)}-${randomHex.slice(4, 8)}-${randomHex.slice(8, 20)}`;
}

function normalizeMessages(transfer: ChatGptCodexTransfer): ChatGptMessage[] {
  const messages = Array.isArray(transfer.messages)
    ? transfer.messages
        .filter(message => message?.role === 'user' || message?.role === 'assistant')
        .map(message => ({
          role: message.role,
          text: String(message.text || '').trim(),
          timestamp: normalizeTimestamp(message.timestamp),
        }))
        .filter(message => message.text)
    : [];
  if (messages.length > 0) return messages;

  const history = String(transfer.history || '').trim();
  return history ? [{ role: 'user', text: history }] : [];
}

interface ChatGptTurn {
  user: string;
  userTimestamp?: string;
  assistant?: string;
  assistantTimestamp?: string;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const source = String(value).trim();
  if (!source) return undefined;
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(source)
    ? Number(value)
    : NaN;
  const milliseconds = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(source);
  if (!Number.isFinite(milliseconds)) return undefined;
  return new Date(milliseconds).toISOString();
}

function groupTurns(messages: ChatGptMessage[]): ChatGptTurn[] {
  const turns: ChatGptTurn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ user: message.text, userTimestamp: message.timestamp });
      continue;
    }
    const current = turns[turns.length - 1];
    if (!current) continue;
    current.assistant = current.assistant
      ? `${current.assistant}\n\n${message.text}`
      : message.text;
    current.assistantTimestamp ??= message.timestamp;
  }
  return turns;
}

function chooseCodexWorkspace(): string {
  // Codex requires a non-null cwd for every task. Keep web imports in a neutral
  // hidden directory rather than attaching them to the user's current project.
  // Attune intentionally never registers this directory as a Codex project.
  mkdirSync(FALLBACK_WORKSPACE, { recursive: true });
  return FALLBACK_WORKSPACE;
}

function taskTitle(transfer: ChatGptCodexTransfer, firstUserMessage: string): string {
  const supplied = String(transfer.title || '')
    .replace(/\s*[|–—-]\s*ChatGPT\s*$/i, '')
    .trim();
  const raw = supplied && !/^chatgpt$/i.test(supplied)
    ? supplied
    : firstUserMessage.split('\n').find(Boolean)?.trim() || 'Imported conversation';
  return `[ChatGPT] ${raw}`.slice(0, 200);
}

function writeThreadRow(
  task: CreatedCodexTask,
  firstUserMessage: string,
  tokens: number,
  createdAt: Date,
  updatedAt: Date,
): void {
  if (!existsSync(CODEX_THREADS_DB)) return;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(CODEX_THREADS_DB);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    database.prepare(`
      INSERT OR REPLACE INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd,
         title, sandbox_policy, approval_mode, has_user_event, archived,
         cli_version, first_user_message, memory_mode, preview, tokens_used)
      VALUES
        (?, ?, ?, ?, 'cli', 'openai', ?,
         ?, '{"type":"danger-full-access"}', 'never', 1, 0,
         '0.1.0', ?, 'enabled', ?, ?)
    `).run(
      task.threadId,
      task.rolloutPath,
      Math.floor(createdAt.getTime() / 1000),
      Math.floor(updatedAt.getTime() / 1000),
      task.cwd,
      task.title,
      firstUserMessage.slice(0, 2000),
      firstUserMessage.slice(0, 200) || 'Imported from ChatGPT',
      Math.max(1, tokens),
    );
  } finally {
    try {
      database?.close();
    } catch {
      // SQLite has already committed the row.
    }
  }
}

export function createCodexTaskFromChatGpt(transfer: ChatGptCodexTransfer): CreatedCodexTask {
  const messages = normalizeMessages(transfer);
  const turns = groupTurns(messages);
  if (turns.length === 0) throw new Error('No ChatGPT conversation messages were provided.');

  const now = new Date();
  const originalTimestamps = messages
    .map(message => message.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp));
  const conversationStartedAt = new Date(originalTimestamps[0] || now.toISOString());
  const conversationEndedAt = new Date(originalTimestamps.at(-1) || conversationStartedAt.toISOString());
  const threadId = uuidV7();
  const cwd = chooseCodexWorkspace();
  const firstUserMessage = turns[0].user;
  const title = taskTitle(transfer, firstUserMessage);
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const sessionDirectory = join(CODEX_SESSIONS_DIR, year, month, day);
  mkdirSync(sessionDirectory, { recursive: true });
  const fileTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rolloutPath = join(sessionDirectory, `rollout-${fileTimestamp}-${threadId}.jsonl`);
  const lines: string[] = [];

  lines.push(JSON.stringify({
    timestamp: conversationStartedAt.toISOString(),
    type: 'session_meta',
    payload: {
      id: threadId,
      timestamp: conversationStartedAt.toISOString(),
      cwd,
      originator: 'Codex CLI',
      cli_version: '0.1.0',
      model_provider: 'openai',
      attune: {
        importedFrom: 'ChatGPT',
        sourceUrl: transfer.sourceUrl || null,
        handoffId: transfer.id || null,
        importedAt: now.toISOString(),
        originalStartedAt: conversationStartedAt.toISOString(),
        originalEndedAt: conversationEndedAt.toISOString(),
        title,
      },
    },
  }));

  let lastEventTime = conversationStartedAt.getTime();
  turns.forEach((turn, index) => {
    const turnId = uuidV7();
    const suppliedUserTime = turn.userTimestamp ? Date.parse(turn.userTimestamp) : NaN;
    const userTime = Number.isFinite(suppliedUserTime)
      ? Math.max(suppliedUserTime, lastEventTime)
      : lastEventTime + (index === 0 ? 0 : 1);
    const userTimestamp = new Date(userTime).toISOString();
    const suppliedAssistantTime = turn.assistantTimestamp ? Date.parse(turn.assistantTimestamp) : NaN;
    const assistantTime = turn.assistant
      ? (Number.isFinite(suppliedAssistantTime)
          ? Math.max(suppliedAssistantTime, userTime)
          : userTime + 1)
      : userTime;
    const assistantTimestamp = new Date(assistantTime).toISOString();
    lines.push(JSON.stringify({
      timestamp: userTimestamp,
      type: 'event_msg',
      payload: {
        type: 'task_started',
        turn_id: turnId,
        model_context_window: 258400,
        collaboration_mode_kind: 'default',
      },
    }));
    lines.push(JSON.stringify({
      timestamp: userTimestamp,
      type: 'turn_context',
      payload: {
        turn_id: turnId,
        cwd,
        approval_policy: 'never',
        sandbox_policy: { type: 'danger-full-access' },
        model: 'gpt-5.5',
        effort: 'medium',
        summary: 'none',
      },
    }));
    lines.push(JSON.stringify({
      timestamp: userTimestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: turn.user }],
      },
    }));
    lines.push(JSON.stringify({
      timestamp: userTimestamp,
      type: 'event_msg',
      payload: { type: 'user_message', message: turn.user, images: [] },
    }));

    if (turn.assistant) {
      lines.push(JSON.stringify({
        timestamp: assistantTimestamp,
        type: 'response_item',
        payload: { type: 'reasoning', summary: [], content: null, encrypted_content: '' },
      }));
      lines.push(JSON.stringify({
        timestamp: assistantTimestamp,
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: turn.assistant,
          phase: 'final_answer',
          memory_citation: null,
        },
      }));
      lines.push(JSON.stringify({
        timestamp: assistantTimestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: turn.assistant }],
          phase: 'final_answer',
        },
      }));
    }

    lines.push(JSON.stringify({
      timestamp: assistantTimestamp,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: (turn.assistant || '').slice(0, 2000),
        completed_at: Math.floor(assistantTime / 1000),
        duration_ms: Math.max(0, assistantTime - userTime),
      },
    }));
    lastEventTime = assistantTime;
  });

  writeFileSync(rolloutPath, `${lines.join('\n')}\n`);
  const task = { threadId, title, cwd, rolloutPath };
  const tokens = Math.ceil(messages.reduce((total, message) => total + message.text.length, 0) / 4);
  writeThreadRow(task, firstUserMessage, tokens, conversationStartedAt, now);
  mkdirSync(CODEX_DIR, { recursive: true });
  appendFileSync(
    CODEX_SESSION_INDEX,
    `${JSON.stringify({ id: threadId, thread_name: title.slice(0, 80), updated_at: now.toISOString() })}\n`,
  );
  return task;
}
