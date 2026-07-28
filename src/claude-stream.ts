import { basename, isAbsolute, resolve } from 'path';

type JsonRecord = Record<string, unknown>;

export interface ClaudeToolCall {
  id: string;
  name: string;
  input: JsonRecord;
}

export type ClaudeStreamUpdate =
  | { type: 'session'; sessionId: string }
  | { type: 'textDelta'; messageId: string; text: string }
  | { type: 'messageFinished'; messageId: string; stopReason: string | null }
  | { type: 'toolStarted'; call: ClaudeToolCall }
  | { type: 'toolFinished'; toolUseId: string; output: string; isError: boolean }
  | { type: 'toolProgress'; toolUseId: string; message: string }
  | { type: 'status'; status: string }
  | {
    type: 'result';
    result: string;
    sessionId: string | null;
    isError: boolean;
    errorMessage: string | null;
    durationMs: number | null;
  };

interface StreamBlock {
  type: string;
  toolUseId: string | null;
  toolName: string | null;
  partialJson: string;
}

/**
 * Stateful decoder for Claude Code's line-delimited stream-json protocol.
 * It deliberately omits extended-thinking text while preserving visible
 * response text, tools, statuses, results, and errors.
 */
export class ClaudeStreamDecoder {
  private currentMessageId: string | null = null;
  private currentMessageText = '';
  private currentStopReason: string | null = null;
  private readonly blocks = new Map<number, StreamBlock>();
  private readonly seenTools = new Set<string>();
  private readonly nestedText = new Map<string, string>();

  pushLine(line: string): ClaudeStreamUpdate[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      return this.push(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }

  push(value: unknown): ClaudeStreamUpdate[] {
    const message = asRecord(value);
    if (!message) return [];

    const updates: ClaudeStreamUpdate[] = [];
    const sessionId = text(message.session_id);
    if (sessionId) updates.push({ type: 'session', sessionId });

    const type = text(message.type);
    if (type === 'stream_event') {
      const parentToolUseId = text(message.parent_tool_use_id);
      if (parentToolUseId) {
        updates.push(...this.pushNestedStreamEvent(asRecord(message.event), parentToolUseId));
        return updates;
      }
      updates.push(...this.pushStreamEvent(asRecord(message.event)));
      return updates;
    }
    if (type === 'assistant') {
      const parentToolUseId = text(message.parent_tool_use_id);
      if (parentToolUseId) {
        updates.push(...this.pushNestedAssistantMessage(asRecord(message.message), parentToolUseId));
        return updates;
      }
      updates.push(...this.pushAssistantMessage(asRecord(message.message)));
      return updates;
    }
    if (type === 'user') {
      updates.push(...this.pushToolResults(message));
      return updates;
    }
    if (type === 'tool_progress' || type === 'progress') {
      const toolUseId = text(message.tool_use_id) ?? text(message.parent_tool_use_id);
      const progress = text(message.message)
        ?? text(message.tool_name)
        ?? (typeof message.elapsed_time_seconds === 'number'
          ? `Running for ${Math.round(message.elapsed_time_seconds)}s`
          : null);
      if (toolUseId && progress) {
        updates.push({ type: 'toolProgress', toolUseId, message: progress });
      }
      return updates;
    }
    if (type === 'system') {
      const subtype = text(message.subtype);
      if (subtype === 'status' && text(message.status)) {
        updates.push({ type: 'status', status: text(message.status)! });
      } else if (subtype === 'compact_boundary') {
        updates.push({ type: 'status', status: 'compacting' });
      } else if (subtype === 'task_progress' || subtype === 'task_notification') {
        const toolUseId = text(message.tool_use_id) ?? text(message.parent_tool_use_id);
        const progress = text(message.description) ?? text(message.summary);
        if (toolUseId && progress) {
          updates.push({ type: 'toolProgress', toolUseId, message: progress });
        }
      }
      return updates;
    }
    if (type === 'result') {
      const subtype = text(message.subtype);
      const isError = message.is_error === true || (subtype !== null && subtype !== 'success');
      const result = printable(message.result) ?? '';
      const errorMessage = isError
        ? text(message.error)
          ?? text(message.api_error_status)
          ?? (result || `Claude Code finished with ${subtype ?? 'an error'}.`)
        : null;
      updates.push({
        type: 'result',
        result,
        sessionId,
        isError,
        errorMessage,
        durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : null,
      });
    }
    return updates;
  }

  private pushNestedStreamEvent(
    event: JsonRecord | null,
    parentToolUseId: string,
  ): ClaudeStreamUpdate[] {
    if (!event) return [];
    const eventType = text(event.type);
    if (eventType === 'message_start') {
      this.nestedText.set(parentToolUseId, '');
      return [];
    }
    if (eventType === 'content_block_delta') {
      const delta = asRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.nestedText.set(
          parentToolUseId,
          `${this.nestedText.get(parentToolUseId) ?? ''}${delta.text}`,
        );
      }
      return [];
    }
    if (eventType === 'content_block_start') {
      const block = asRecord(event.content_block);
      if (block?.type === 'tool_use' && text(block.name)) {
        return [{
          type: 'toolProgress',
          toolUseId: parentToolUseId,
          message: `Subagent is using ${text(block.name)!}`,
        }];
      }
      return [];
    }
    if (eventType === 'message_stop') {
      const summary = this.nestedText.get(parentToolUseId)?.trim();
      this.nestedText.delete(parentToolUseId);
      return summary
        ? [{
          type: 'toolProgress',
          toolUseId: parentToolUseId,
          message: limitText(summary, 500),
        }]
        : [];
    }
    return [];
  }

  private pushNestedAssistantMessage(
    message: JsonRecord | null,
    parentToolUseId: string,
  ): ClaudeStreamUpdate[] {
    if (!message) return [];
    const content = Array.isArray(message.content) ? message.content : [];
    const streamed = this.nestedText.get(parentToolUseId)?.trim() ?? '';
    const textContent = content
      .map(asRecord)
      .filter((block): block is JsonRecord => Boolean(block?.type === 'text'))
      .map(block => typeof block.text === 'string' ? block.text : '')
      .join('\n')
      .trim();
    if (!streamed && textContent) {
      return [{
        type: 'toolProgress',
        toolUseId: parentToolUseId,
        message: limitText(textContent, 500),
      }];
    }
    return [];
  }

  private pushStreamEvent(event: JsonRecord | null): ClaudeStreamUpdate[] {
    if (!event) return [];
    const eventType = text(event.type);
    if (eventType === 'message_start') {
      const message = asRecord(event.message);
      this.currentMessageId = text(message?.id) ?? `claude-message-${Date.now()}`;
      this.currentMessageText = '';
      this.currentStopReason = null;
      this.blocks.clear();
      return [];
    }
    if (eventType === 'content_block_start') {
      const index = number(event.index);
      const block = asRecord(event.content_block);
      if (index === null || !block) return [];
      const blockType = text(block.type) ?? 'unknown';
      this.blocks.set(index, {
        type: blockType,
        toolUseId: text(block.id),
        toolName: text(block.name),
        partialJson: hasProperties(block.input) ? JSON.stringify(block.input) : '',
      });
      if (blockType === 'text' && text(block.text)) {
        return this.textUpdates(text(block.text)!);
      }
      return [];
    }
    if (eventType === 'content_block_delta') {
      const index = number(event.index);
      const delta = asRecord(event.delta);
      if (!delta) return [];
      const deltaType = text(delta.type);
      if (deltaType === 'text_delta' && typeof delta.text === 'string') {
        return this.textUpdates(delta.text);
      }
      if (deltaType === 'input_json_delta' && index !== null) {
        const block = this.blocks.get(index);
        if (block && typeof delta.partial_json === 'string') {
          block.partialJson += delta.partial_json;
        }
      }
      if (deltaType === 'thinking_delta') {
        return [{ type: 'status', status: 'reasoning' }];
      }
      return [];
    }
    if (eventType === 'content_block_stop') {
      const index = number(event.index);
      const block = index === null ? null : this.blocks.get(index);
      if (!block?.toolUseId || !block.toolName || this.seenTools.has(block.toolUseId)) return [];
      const input = parseJsonRecord(block.partialJson);
      this.seenTools.add(block.toolUseId);
      return [{
        type: 'toolStarted',
        call: { id: block.toolUseId, name: block.toolName, input },
      }];
    }
    if (eventType === 'message_delta') {
      const delta = asRecord(event.delta);
      this.currentStopReason = text(delta?.stop_reason);
      return [];
    }
    if (eventType === 'message_stop') {
      if (!this.currentMessageId) return [];
      const update: ClaudeStreamUpdate = {
        type: 'messageFinished',
        messageId: this.currentMessageId,
        stopReason: this.currentStopReason,
      };
      this.currentMessageId = null;
      this.currentMessageText = '';
      this.currentStopReason = null;
      this.blocks.clear();
      return [update];
    }
    return [];
  }

  private pushAssistantMessage(message: JsonRecord | null): ClaudeStreamUpdate[] {
    if (!message) return [];
    const messageId = text(message.id) ?? this.currentMessageId ?? `claude-message-${Date.now()}`;
    if (!this.currentMessageId) this.currentMessageId = messageId;
    const updates: ClaudeStreamUpdate[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const value of content) {
      const block = asRecord(value);
      if (!block) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        const streamed = this.currentMessageText;
        if (!streamed) {
          updates.push(...this.textUpdates(block.text));
        } else if (block.text.startsWith(streamed) && block.text.length > streamed.length) {
          updates.push(...this.textUpdates(block.text.slice(streamed.length)));
        }
      }
      if (block.type === 'tool_use') {
        const toolUseId = text(block.id);
        const toolName = text(block.name);
        if (!toolUseId || !toolName || this.seenTools.has(toolUseId)) continue;
        this.seenTools.add(toolUseId);
        updates.push({
          type: 'toolStarted',
          call: {
            id: toolUseId,
            name: toolName,
            input: asRecord(block.input) ?? {},
          },
        });
      }
    }
    return updates;
  }

  private pushToolResults(message: JsonRecord): ClaudeStreamUpdate[] {
    const content = asRecord(message.message)?.content;
    if (!Array.isArray(content)) return [];
    const updates: ClaudeStreamUpdate[] = [];
    for (const value of content) {
      const block = asRecord(value);
      if (block?.type !== 'tool_result') continue;
      const toolUseId = text(block.tool_use_id);
      if (!toolUseId) continue;
      updates.push({
        type: 'toolFinished',
        toolUseId,
        output: printable(block.content)
          || printable(message.tool_use_result)
          || '',
        isError: block.is_error === true,
      });
    }
    return updates;
  }

  private textUpdates(value: string): ClaudeStreamUpdate[] {
    if (!value || !this.currentMessageId) return [];
    this.currentMessageText += value;
    return [{
      type: 'textDelta',
      messageId: this.currentMessageId,
      text: value,
    }];
  }
}

export function createCodexToolItem(
  call: ClaudeToolCall,
  cwd: string,
): Record<string, unknown> {
  const command = commandForTool(call, cwd);
  if (command) {
    return {
      type: 'commandExecution',
      id: call.id,
      command: command.command,
      cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [command.action],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
  }

  if (call.name === 'WebSearch') {
    const query = text(call.input.query) ?? printable(call.input) ?? 'Web search';
    return {
      type: 'webSearch',
      id: call.id,
      query,
      action: { type: 'search', query, queries: null },
      results: null,
    };
  }
  if (call.name === 'WebFetch') {
    const url = text(call.input.url) ?? '';
    return {
      type: 'webSearch',
      id: call.id,
      query: text(call.input.prompt) ?? (url || 'Open page'),
      action: { type: 'openPage', url: url || null },
      results: null,
    };
  }

  return {
    type: 'mcpToolCall',
    id: call.id,
    server: 'Claude Code',
    tool: call.name,
    status: 'inProgress',
    arguments: {
      ...call.input,
      title: toolTitle(call),
    },
    appContext: null,
    pluginId: null,
    result: null,
    error: null,
    durationMs: null,
  };
}

export function completeCodexToolItem(
  item: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
): Record<string, unknown> {
  const displayOutput = limitText(output, 500_000);
  if (item.type === 'commandExecution') {
    return {
      ...item,
      status: isError ? 'failed' : 'completed',
      aggregatedOutput: displayOutput,
      exitCode: isError ? 1 : 0,
      durationMs,
    };
  }
  if (item.type === 'webSearch') {
    return {
      ...item,
      results: displayOutput ? [{ type: 'text', text: displayOutput }] : [],
    };
  }
  return {
    ...item,
    status: isError ? 'failed' : 'completed',
    result: isError || !displayOutput
      ? null
      : {
        content: [{ type: 'text', text: displayOutput }],
        structuredContent: null,
        _meta: null,
      },
    error: isError ? { message: displayOutput || 'Claude Code tool failed.' } : null,
    durationMs,
  };
}

export function failCodexToolItem(
  item: Record<string, unknown>,
  message: string,
  durationMs: number,
): Record<string, unknown> {
  return completeCodexToolItem(item, message, true, durationMs);
}

function commandForTool(
  call: ClaudeToolCall,
  cwd: string,
): { command: string; action: Record<string, unknown> } | null {
  if (call.name === 'Bash') {
    const command = text(call.input.command) ?? 'shell command';
    return { command, action: { type: 'unknown', command } };
  }
  if (call.name === 'Read') {
    const rawPath = text(call.input.file_path) ?? text(call.input.path) ?? '';
    const path = absolutePath(rawPath, cwd);
    const command = `Read ${path || rawPath || 'file'}`;
    return {
      command,
      action: {
        type: 'read',
        command,
        name: path ? basename(path) : 'file',
        path: path || cwd,
      },
    };
  }
  if (call.name === 'Glob' || call.name === 'LS') {
    const path = text(call.input.path);
    const pattern = text(call.input.pattern);
    const command = `List files${pattern ? ` matching ${pattern}` : ''}${path ? ` in ${path}` : ''}`;
    return {
      command,
      action: {
        type: 'listFiles',
        command,
        path: path ? absolutePath(path, cwd) : null,
      },
    };
  }
  if (call.name === 'Grep') {
    const query = text(call.input.pattern) ?? text(call.input.query);
    const rawPath = text(call.input.path);
    const command = `Search${query ? ` for ${query}` : ''}${rawPath ? ` in ${rawPath}` : ''}`;
    return {
      command,
      action: {
        type: 'search',
        command,
        query,
        path: rawPath ? absolutePath(rawPath, cwd) : null,
      },
    };
  }
  return null;
}

function toolTitle(call: ClaudeToolCall): string {
  const description = text(call.input.description);
  if (description) return description;
  const path = text(call.input.file_path) ?? text(call.input.path);
  if (path) return `${call.name} ${path}`;
  const subject = text(call.input.query) ?? text(call.input.prompt);
  return subject ? `${call.name}: ${limitText(subject, 100)}` : call.name;
}

function absolutePath(value: string, cwd: string): string {
  if (!value) return '';
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function parseJsonRecord(value: string): JsonRecord {
  if (!value) return {};
  try {
    return asRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function printable(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function limitText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n\n[Output truncated by Attune]`;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function hasProperties(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}
