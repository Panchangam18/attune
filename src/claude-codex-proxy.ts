#!/usr/bin/env node

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import {
  ClaudeStreamDecoder,
  completeCodexToolItem,
  createCodexToolItem,
  failCodexToolItem,
  type ClaudeStreamUpdate,
} from './claude-stream.js';

type RequestId = string | number;
type ClaudeModelId = 'claude-fable' | 'claude-opus';
type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ProtocolMessage {
  id?: RequestId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  emittedAtMs?: number;
}

interface SyntheticTurn {
  id: string;
  items: Array<Record<string, unknown>>;
  itemsView: 'summary';
  status: 'completed' | 'interrupted' | 'failed';
  error: Record<string, unknown> | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface ClaudeThreadState {
  model: ClaudeModelId | null;
  effort: ClaudeEffort;
  serviceTier: string | null;
  sessionId: string;
  hasStartedSession: boolean;
  cwd: string;
  turns: SyntheticTurn[];
}

interface ProxyState {
  version: 1;
  threads: Record<string, ClaudeThreadState>;
}

interface PendingRequest {
  method: string;
  params: Record<string, unknown>;
  selectedModel?: ClaudeModelId;
}

interface ClaudeInvocationResult {
  finalText: string;
  sessionId: string | null;
  isError: boolean;
  errorMessage: string | null;
  durationMs: number | null;
}

interface ActiveToolItem {
  item: Record<string, unknown>;
  startedAtMs: number;
}

interface ActiveAgentMessage {
  item: Record<string, unknown>;
  startedAtMs: number;
  text: string;
  completed: boolean;
  phase: 'commentary' | 'final_answer';
}

const REAL_CODEX = process.env.ATTUNE_REAL_CODEX_CLI_PATH
  || '/Applications/ChatGPT.app/Contents/Resources/codex';
const CLAUDE_CLI = process.env.ATTUNE_CLAUDE_CLI_PATH || 'claude';
const FALLBACK_CODEX_MODEL = process.env.ATTUNE_CLAUDE_FALLBACK_CODEX_MODEL || 'gpt-5.6-terra';
const STATE_PATH = process.env.ATTUNE_CLAUDE_CODEX_STATE_PATH
  || join(homedir(), '.attune', 'claude-codex-proxy.json');
const CLAUDE_MODELS: Record<ClaudeModelId, Record<string, unknown>> = {
  'claude-fable': {
    id: 'claude-fable',
    model: 'claude-fable',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Claude Fable 5',
    description: 'Claude Fable 5 through the local Claude Code CLI.',
    hidden: false,
    supportedReasoningEfforts: effortOptions(),
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
  'claude-opus': {
    id: 'claude-opus',
    model: 'claude-opus',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Claude Opus 5',
    description: 'Claude Opus 5 through the local Claude Code CLI.',
    hidden: false,
    supportedReasoningEfforts: effortOptions(),
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
};

const args = process.argv.slice(2);
if (!args.includes('app-server')) {
  const child = spawn(REAL_CODEX, args, { env: process.env, stdio: 'inherit' });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} else {
  runProxy();
}

function effortOptions(): Array<Record<string, string>> {
  return [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'medium', description: 'Balanced reasoning depth' },
    { reasoningEffort: 'high', description: 'Greater reasoning depth' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth' },
    { reasoningEffort: 'max', description: 'Maximum reasoning depth' },
  ];
}

function runProxy(): void {
  const realServer = spawn(REAL_CODEX, args, {
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const state = readState();
  const pending = new Map<string, PendingRequest>();
  const internalRequestIds = new Set<string>();
  const activeClaude = new Map<string, { child: ChildProcess; threadId: string }>();
  const clientLines = createInterface({ input: process.stdin });
  const serverLines = createInterface({ input: realServer.stdout! });

  const sendClient = (message: ProtocolMessage): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const sendServer = (message: ProtocolMessage): void => {
    realServer.stdin!.write(`${JSON.stringify(message)}\n`);
  };

  clientLines.on('line', line => {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
    } catch {
      realServer.stdin!.write(`${line}\n`);
      return;
    }

    const requestKey = message.id === undefined ? null : keyFor(message.id);
    const method = message.method;
    const params = message.params ?? {};
    if (requestKey && method) pending.set(requestKey, { method, params });

    if (method === 'turn/start' && requestKey) {
      const threadId = asString(params.threadId);
      const requestedModel = claudeModel(params.model);
      const threadState = threadId ? state.threads[threadId] : undefined;
      const selectedModel = requestedModel ?? threadState?.model ?? null;
      if (threadId && selectedModel) {
        const effort = claudeEffort(params.effort) ?? threadState?.effort ?? defaultEffort(selectedModel);
        const serviceTier = asString(params.serviceTier);
        const nextState = threadState ?? createThreadState(selectedModel, effort, serviceTier, asString(params.cwd));
        nextState.model = selectedModel;
        nextState.effort = effort;
        nextState.serviceTier = serviceTier;
        if (asString(params.cwd)) nextState.cwd = asString(params.cwd)!;
        state.threads[threadId] = nextState;
        writeState(state);
        pending.delete(requestKey);
        void runClaudeTurn({
          activeClaude,
          effort,
          message,
          model: selectedModel,
          params,
          realServer,
          requestId: message.id!,
          sendClient,
          state,
          threadId,
          threadState: nextState,
        });
        return;
      }
    }

    if (method === 'turn/interrupt' && requestKey) {
      const threadId = asString(params.threadId);
      const active = threadId
        ? [...activeClaude.values()].find(entry => entry.threadId === threadId)
        : undefined;
      if (active) {
        active.child.kill('SIGTERM');
        pending.delete(requestKey);
        sendClient({ id: message.id, result: {} });
        return;
      }
    }

    if (method === 'thread/start' && requestKey) {
      const selectedModel = claudeModel(params.model);
      if (selectedModel) {
        pending.set(requestKey, { method, params, selectedModel });
        message = {
          ...message,
          params: { ...params, model: FALLBACK_CODEX_MODEL },
        };
      }
    } else if (method === 'thread/settings/update') {
      const threadId = asString(params.threadId);
      const selectedModel = claudeModel(params.model);
      if (threadId && selectedModel) {
        const effort = claudeEffort(params.effort) ?? defaultEffort(selectedModel);
        const existing = state.threads[threadId] ?? createThreadState(
          selectedModel,
          effort,
          asString(params.serviceTier),
          null,
        );
        existing.model = selectedModel;
        existing.effort = effort;
        existing.serviceTier = asString(params.serviceTier);
        state.threads[threadId] = existing;
        writeState(state);
        message = {
          ...message,
          params: { ...params, model: FALLBACK_CODEX_MODEL },
        };
      } else if (threadId && typeof params.model === 'string') {
        const existing = state.threads[threadId];
        if (existing) {
          existing.model = null;
          writeState(state);
        }
      }
    }

    sendServer(message);
  });

  serverLines.on('line', line => {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }

    if (message.id !== undefined) {
      const requestKey = keyFor(message.id);
      if (internalRequestIds.delete(requestKey)) return;
      const request = pending.get(requestKey);
      if (request) {
        pending.delete(requestKey);
        rewriteResponse(message, request, state);
      }
    } else {
      rewriteNotification(message, state);
    }
    sendClient(message);
  });

  const stopChildren = (): void => {
    for (const { child } of activeClaude.values()) child.kill('SIGTERM');
    realServer.kill('SIGTERM');
  };
  process.stdin.once('end', stopChildren);
  process.once('SIGINT', () => {
    stopChildren();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stopChildren();
    process.exit(143);
  });
  realServer.once('exit', (code, signal) => {
    for (const { child } of activeClaude.values()) child.kill('SIGTERM');
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });

  function injectHistory(threadId: string, prompt: string, response: string): void {
    const id = `attune-internal-${randomUUID()}`;
    internalRequestIds.add(keyFor(id));
    sendServer({
      id,
      method: 'thread/inject_items',
      params: {
        threadId,
        items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response }] },
        ],
      },
    });
  }

  async function runClaudeTurn(input: {
    activeClaude: Map<string, { child: ChildProcess; threadId: string }>;
    effort: ClaudeEffort;
    message: ProtocolMessage;
    model: ClaudeModelId;
    params: Record<string, unknown>;
    realServer: ChildProcess;
    requestId: RequestId;
    sendClient: (message: ProtocolMessage) => void;
    state: ProxyState;
    threadId: string;
    threadState: ClaudeThreadState;
  }): Promise<void> {
    const startedAtMs = Date.now();
    const startedAt = Math.floor(startedAtMs / 1000);
    const turnId = randomUUID();
    const userItemId = randomUUID();
    const prompt = extractPrompt(input.params.input);
    const emittedItems: Array<Record<string, unknown>> = [];
    const agentMessages = new Map<string, ActiveAgentMessage>();
    const tools = new Map<string, ActiveToolItem>();
    let finalText = '';
    let invocationResult: ClaudeInvocationResult | null = null;
    let stopped = false;
    let failureMessage: string | null = null;
    let lastStatus = '';
    const emit = (method: string, params: Record<string, unknown>): void => {
      input.sendClient({ method, params, emittedAtMs: Date.now() });
    };
    const userItem = {
      type: 'userMessage',
      id: userItemId,
      clientId: asString(input.params.clientUserMessageId),
      content: Array.isArray(input.params.input) ? input.params.input : [],
    };
    const inProgressTurn = {
      id: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };
    sendClient({ id: input.requestId, result: { turn: inProgressTurn } });
    emit('thread/status/changed', {
      threadId: input.threadId,
      status: { type: 'active', activeFlags: [] },
    });
    emit('turn/started', { threadId: input.threadId, turn: inProgressTurn });
    emit('item/started', {
      item: userItem,
      threadId: input.threadId,
      turnId,
      startedAtMs,
    });
    emit('item/completed', {
      item: userItem,
      threadId: input.threadId,
      turnId,
      completedAtMs: startedAtMs,
    });

    const invocationItemId = `claude_${randomUUID().replaceAll('-', '')}`;
    const invocationStartedAtMs = Date.now();
    const invocationItem = {
      type: 'mcpToolCall',
      id: invocationItemId,
      server: 'Claude Code',
      tool: 'agent',
      status: 'inProgress',
      arguments: {
        title: `${displayName(input.model)} · ${input.effort} effort`,
        model: exactModelName(input.model),
        effort: input.effort,
      },
      appContext: null,
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    };
    emit('item/started', {
      item: invocationItem,
      threadId: input.threadId,
      turnId,
      startedAtMs: invocationStartedAtMs,
    });
    emit('item/mcpToolCall/progress', {
      threadId: input.threadId,
      turnId,
      itemId: invocationItemId,
      message: 'Starting local Claude Code session',
    });

    try {
      invocationResult = await invokeClaude(input, turnId, prompt, handleStreamUpdate);
      finalText = invocationResult.finalText;
      failureMessage = invocationResult.isError
        ? invocationResult.errorMessage ?? 'Claude Code returned an error.'
        : null;
    } catch (error) {
      stopped = (error as Error).message === 'Claude Code request stopped.';
      failureMessage = stopped ? null : (error as Error).message;
    }

    for (const [toolUseId, active] of tools) {
      const completedAtMs = Date.now();
      const completed = failCodexToolItem(
        active.item,
        stopped ? 'Stopped by user.' : failureMessage ?? 'Claude Code ended before the tool returned.',
        completedAtMs - active.startedAtMs,
      );
      emit('item/completed', {
        item: completed,
        threadId: input.threadId,
        turnId,
        completedAtMs,
      });
      emittedItems.push(completed);
      tools.delete(toolUseId);
    }

    completeOpenAgentMessages();
    if (!stopped && !failureMessage && finalText && !hasFinalMessage(finalText)) {
      appendFallbackFinalMessage(finalText);
    }

    const completedAtMs = Date.now();
    const completedAt = Math.floor(completedAtMs / 1000);
    const invocationCompleted = completeCodexToolItem(
      invocationItem,
      failureMessage
        ? failureMessage
        : stopped
          ? 'Stopped by user.'
          : `Completed in ${completedAtMs - invocationStartedAtMs}ms.`,
      Boolean(failureMessage) || stopped,
      invocationResult?.durationMs ?? completedAtMs - invocationStartedAtMs,
    );
    emit('item/completed', {
      item: invocationCompleted,
      threadId: input.threadId,
      turnId,
      completedAtMs,
    });
    emittedItems.unshift(invocationCompleted);
    emit('thread/status/changed', {
      threadId: input.threadId,
      status: { type: 'idle' },
    });

    const turnStatus = stopped ? 'interrupted' : failureMessage ? 'failed' : 'completed';
    const turnError = failureMessage
      ? {
        message: failureMessage,
        codexErrorInfo: null,
        additionalDetails: null,
      }
      : null;
    if (turnError) {
      emit('error', {
        error: turnError,
        willRetry: false,
        threadId: input.threadId,
        turnId,
      });
    }
    const completedTurn: SyntheticTurn = {
      id: turnId,
      items: [userItem, ...emittedItems],
      itemsView: 'summary',
      status: turnStatus,
      error: turnError,
      startedAt,
      completedAt,
      durationMs: completedAtMs - startedAtMs,
    };
    emit('turn/completed', { threadId: input.threadId, turn: completedTurn });
    input.threadState.turns.push(completedTurn);
    writeState(input.state);
    if (turnStatus === 'completed' && prompt && finalText) {
      injectHistory(input.threadId, prompt, finalText);
    }

    function handleStreamUpdate(update: ClaudeStreamUpdate): void {
      if (update.type === 'session') {
        input.threadState.sessionId = update.sessionId;
        input.threadState.hasStartedSession = true;
        return;
      }
      if (update.type === 'status') {
        const status = statusMessage(update.status);
        if (!status || status === lastStatus) return;
        lastStatus = status;
        emit('item/mcpToolCall/progress', {
          threadId: input.threadId,
          turnId,
          itemId: invocationItemId,
          message: status,
        });
        return;
      }
      if (update.type === 'textDelta') {
        const active = ensureAgentMessage(update.messageId);
        active.text += update.text;
        active.item.text = active.text;
        emit('item/agentMessage/delta', {
          threadId: input.threadId,
          turnId,
          itemId: active.item.id,
          delta: update.text,
        });
        return;
      }
      if (update.type === 'messageFinished') {
        const active = agentMessages.get(update.messageId);
        if (!active || active.completed) return;
        active.phase = update.stopReason === 'end_turn' ? 'final_answer' : 'commentary';
        completeAgentMessage(active);
        return;
      }
      if (update.type === 'toolStarted') {
        if (tools.has(update.call.id)) return;
        const startedAtMs = Date.now();
        const item = createCodexToolItem(update.call, input.threadState.cwd || homedir());
        tools.set(update.call.id, { item, startedAtMs });
        emit('item/started', {
          item,
          threadId: input.threadId,
          turnId,
          startedAtMs,
        });
        return;
      }
      if (update.type === 'toolProgress') {
        const active = tools.get(update.toolUseId);
        if (!active || active.item.type !== 'mcpToolCall') return;
        emit('item/mcpToolCall/progress', {
          threadId: input.threadId,
          turnId,
          itemId: active.item.id,
          message: update.message,
        });
        return;
      }
      if (update.type === 'toolFinished') {
        const active = tools.get(update.toolUseId);
        if (!active) return;
        const completedAtMs = Date.now();
        if (active.item.type === 'commandExecution' && update.output) {
          emit('item/commandExecution/outputDelta', {
            threadId: input.threadId,
            turnId,
            itemId: active.item.id,
            delta: update.output,
          });
        }
        const completed = completeCodexToolItem(
          active.item,
          update.output,
          update.isError,
          completedAtMs - active.startedAtMs,
        );
        emit('item/completed', {
          item: completed,
          threadId: input.threadId,
          turnId,
          completedAtMs,
        });
        emittedItems.push(completed);
        tools.delete(update.toolUseId);
        return;
      }
      if (update.type === 'result') {
        finalText = update.result || finalText;
        if (update.sessionId) {
          input.threadState.sessionId = update.sessionId;
          input.threadState.hasStartedSession = true;
        }
        if (update.isError) {
          failureMessage = update.errorMessage ?? 'Claude Code returned an error.';
        }
      }
    }

    function ensureAgentMessage(messageId: string): ActiveAgentMessage {
      const existing = agentMessages.get(messageId);
      if (existing) return existing;
      const startedAtMs = Date.now();
      const item = {
        type: 'agentMessage',
        id: messageId.startsWith('msg_')
          ? messageId
          : `msg_${randomUUID().replaceAll('-', '')}`,
        text: '',
        phase: 'commentary',
        memoryCitation: null,
      };
      const active: ActiveAgentMessage = {
        item,
        startedAtMs,
        text: '',
        completed: false,
        phase: 'commentary',
      };
      agentMessages.set(messageId, active);
      emit('item/started', {
        item,
        threadId: input.threadId,
        turnId,
        startedAtMs,
      });
      return active;
    }

    function completeAgentMessage(active: ActiveAgentMessage): void {
      if (active.completed) return;
      active.completed = true;
      const item = {
        ...active.item,
        text: active.text,
        phase: active.phase,
      };
      emit('item/completed', {
        item,
        threadId: input.threadId,
        turnId,
        completedAtMs: Date.now(),
      });
      emittedItems.push(item);
    }

    function completeOpenAgentMessages(): void {
      const open = [...agentMessages.values()].filter(message => !message.completed);
      for (const [index, active] of open.entries()) {
        active.phase = index === open.length - 1 && !failureMessage && !stopped
          ? 'final_answer'
          : 'commentary';
        completeAgentMessage(active);
      }
    }

    function hasFinalMessage(text: string): boolean {
      return [...agentMessages.values()].some(message => (
        message.completed
        && message.phase === 'final_answer'
        && message.text.trim() === text.trim()
      ));
    }

    function appendFallbackFinalMessage(text: string): void {
      const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
      const active = ensureAgentMessage(messageId);
      active.phase = 'final_answer';
      active.text = text;
      active.item.text = text;
      emit('item/agentMessage/delta', {
        threadId: input.threadId,
        turnId,
        itemId: active.item.id,
        delta: text,
      });
      completeAgentMessage(active);
    }
  }

  function invokeClaude(
    input: {
      activeClaude: Map<string, { child: ChildProcess; threadId: string }>;
      effort: ClaudeEffort;
      model: ClaudeModelId;
      threadId: string;
      threadState: ClaudeThreadState;
    },
    turnId: string,
    prompt: string,
    onUpdate: (update: ClaudeStreamUpdate) => void,
  ): Promise<ClaudeInvocationResult> {
    const model = exactModelName(input.model);
    const cliArgs = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', model,
      '--effort', input.effort,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', 'AskUserQuestion',
      '--append-system-prompt', claudeBridgeInstructions(input.model),
      ...(input.threadState.hasStartedSession
        ? ['--resume', input.threadState.sessionId]
        : ['--session-id', input.threadState.sessionId]),
      prompt,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_CLI, cliArgs, {
        cwd: input.threadState.cwd || homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      input.activeClaude.set(turnId, { child, threadId: input.threadId });
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let streamResult: ClaudeInvocationResult | null = null;
      let latestSessionId: string | null = null;
      let latestMessageId: string | null = null;
      const messageText = new Map<string, string>();
      let finalStreamedText = '';
      const decoder = new ClaudeStreamDecoder();
      const outputLines = createInterface({ input: child.stdout! });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, 15 * 60 * 1000);
      outputLines.on('line', line => {
        for (const update of decoder.pushLine(line)) {
          if (update.type === 'session') latestSessionId = update.sessionId;
          if (update.type === 'textDelta') {
            latestMessageId = update.messageId;
            messageText.set(
              update.messageId,
              `${messageText.get(update.messageId) ?? ''}${update.text}`,
            );
          }
          if (update.type === 'messageFinished') {
            const text = messageText.get(update.messageId) ?? '';
            if (update.stopReason === 'end_turn' && text) finalStreamedText = text;
          }
          if (update.type === 'result') {
            streamResult = {
              finalText: update.result,
              sessionId: update.sessionId ?? latestSessionId,
              isError: update.isError,
              errorMessage: update.errorMessage,
              durationMs: update.durationMs,
            };
          }
          try {
            onUpdate(update);
          } catch (error) {
            process.stderr.write(`[attune] Claude stream translation error: ${(error as Error).message}\n`);
          }
        }
      });
      child.stderr?.on('data', chunk => {
        if (stderr.length < 1_000_000) stderr += String(chunk);
      });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.activeClaude.delete(turnId);
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outputLines.close();
        input.activeClaude.delete(turnId);
        if (timedOut) {
          reject(new Error('Claude Code request timed out after 15 minutes.'));
          return;
        }
        if (signal === 'SIGTERM') {
          reject(new Error('Claude Code request stopped.'));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Claude Code exited with status ${code}`));
          return;
        }
        const fallbackText = finalStreamedText
          || (latestMessageId ? messageText.get(latestMessageId) ?? '' : '');
        const result = streamResult ?? {
          finalText: fallbackText,
          sessionId: latestSessionId,
          isError: false,
          errorMessage: null,
          durationMs: null,
        };
        if (!result.finalText) result.finalText = fallbackText;
        if (result.sessionId) {
          input.threadState.sessionId = result.sessionId;
          input.threadState.hasStartedSession = true;
        }
        resolve(result);
      });
    });
  }
}

function rewriteResponse(message: ProtocolMessage, request: PendingRequest, state: ProxyState): void {
  if (message.error || !message.result) return;
  if (request.method === 'model/list') {
    const data = message.result.data;
    if (Array.isArray(data)) {
      const withoutDuplicates = data.filter(model => {
        const id = asString((model as Record<string, unknown>)?.id);
        return !id || !claudeModel(id);
      });
      message.result.data = [
        ...withoutDuplicates,
        CLAUDE_MODELS['claude-fable'],
        CLAUDE_MODELS['claude-opus'],
      ];
    }
    return;
  }
  if (request.method === 'thread/start' && request.selectedModel) {
    const thread = asRecord(message.result.thread);
    const threadId = asString(thread?.id);
    if (!threadId) return;
    const effort = claudeEffort(request.params.effort) ?? defaultEffort(request.selectedModel);
    const threadState = createThreadState(
      request.selectedModel,
      effort,
      asString(request.params.serviceTier),
      asString(message.result.cwd) ?? asString(request.params.cwd),
    );
    state.threads[threadId] = threadState;
    writeState(state);
    message.result.model = request.selectedModel;
    message.result.reasoningEffort = effort;
    message.result.serviceTier = threadState.serviceTier ?? 'default';
    return;
  }
  if (request.method === 'thread/resume') {
    const thread = asRecord(message.result.thread);
    const threadId = asString(thread?.id);
    const threadState = threadId ? state.threads[threadId] : undefined;
    if (threadState?.model) {
      message.result.model = threadState.model;
      message.result.reasoningEffort = threadState.effort;
      message.result.serviceTier = threadState.serviceTier ?? 'default';
    }
    mergeTurnsIntoThread(thread, threadState);
    return;
  }
  if (request.method === 'thread/read') {
    const thread = asRecord(message.result.thread);
    const threadId = asString(thread?.id);
    mergeTurnsIntoThread(thread, threadId ? state.threads[threadId] : undefined);
    return;
  }
  if (request.method === 'thread/turns/list') {
    const threadId = asString(request.params.threadId);
    const threadState = threadId ? state.threads[threadId] : undefined;
    if (!threadState || !Array.isArray(message.result.data) || request.params.cursor) return;
    const descending = request.params.sortDirection !== 'ascending';
    const merged = mergeTurns(message.result.data, threadState.turns, descending);
    const limit = typeof request.params.limit === 'number' ? request.params.limit : null;
    message.result.data = limit ? merged.slice(0, limit) : merged;
  }
}

function rewriteNotification(message: ProtocolMessage, state: ProxyState): void {
  if (message.method !== 'thread/settings/updated' || !message.params) return;
  const threadId = asString(message.params.threadId);
  const threadState = threadId ? state.threads[threadId] : undefined;
  const settings = asRecord(message.params.threadSettings);
  if (!threadState?.model || !settings) return;
  settings.model = threadState.model;
  settings.effort = threadState.effort;
  settings.serviceTier = threadState.serviceTier ?? 'default';
  const collaborationMode = asRecord(settings.collaborationMode);
  const collaborationSettings = asRecord(collaborationMode?.settings);
  if (collaborationSettings) {
    collaborationSettings.model = threadState.model;
    collaborationSettings.reasoning_effort = threadState.effort;
  }
}

function createThreadState(
  model: ClaudeModelId,
  effort: ClaudeEffort,
  serviceTier: string | null,
  cwd: string | null,
): ClaudeThreadState {
  return {
    model,
    effort,
    serviceTier,
    sessionId: randomUUID(),
    hasStartedSession: false,
    cwd: cwd || homedir(),
    turns: [],
  };
}

function readState(): ProxyState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProxyState;
    if (parsed.version === 1 && parsed.threads && typeof parsed.threads === 'object') return parsed;
  } catch {
    // Start with an empty sidecar when state is missing or from an older format.
  }
  return { version: 1, threads: {} };
}

function writeState(state: ProxyState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, STATE_PATH);
}

function mergeTurnsIntoThread(
  thread: Record<string, unknown> | null,
  threadState: ClaudeThreadState | undefined,
): void {
  if (!thread || !threadState || !Array.isArray(thread.turns)) return;
  thread.turns = mergeTurns(thread.turns, threadState.turns, false);
}

function mergeTurns(
  realTurns: unknown[],
  syntheticTurns: SyntheticTurn[],
  descending: boolean,
): unknown[] {
  const byId = new Map<string, unknown>();
  for (const turn of [...realTurns, ...syntheticTurns]) {
    const id = asString(asRecord(turn)?.id);
    if (id) byId.set(id, turn);
  }
  return [...byId.values()].sort((left, right) => {
    const leftStarted = Number(asRecord(left)?.startedAt ?? 0);
    const rightStarted = Number(asRecord(right)?.startedAt ?? 0);
    return descending ? rightStarted - leftStarted : leftStarted - rightStarted;
  });
}

function extractPrompt(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .flatMap(item => {
      const record = asRecord(item);
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n');
}

function claudeModel(value: unknown): ClaudeModelId | null {
  return value === 'claude-fable' || value === 'claude-opus' ? value : null;
}

function claudeEffort(value: unknown): ClaudeEffort | null {
  return value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
    ? value
    : null;
}

function defaultEffort(model: ClaudeModelId): ClaudeEffort {
  return model === 'claude-opus' ? 'high' : 'medium';
}

function exactModelName(model: ClaudeModelId): string {
  return model === 'claude-fable' ? 'claude-fable-5' : 'claude-opus-5';
}

function displayName(model: ClaudeModelId): string {
  return model === 'claude-fable' ? 'Claude Fable 5' : 'Claude Opus 5';
}

function claudeBridgeInstructions(model: ClaudeModelId): string {
  return [
    'You are running inside ChatGPT desktop through the Attune Codex bridge.',
    `Authoritative runtime model identity: ${displayName(model)} (model ID ${exactModelName(model)}).`,
    'If asked which model you are, use that exact identity even if your pretrained knowledge suggests an older model.',
    'The AskUserQuestion tool is unavailable in this noninteractive bridge.',
    'When you need information or a choice from the user, ask the question directly in your assistant response, then end the turn and wait for their next message.',
  ].join(' ');
}

function statusMessage(status: string): string | null {
  if (status === 'requesting') return 'Waiting for Claude response';
  if (status === 'reasoning') return 'Claude is reasoning';
  if (status === 'compacting') return 'Compacting Claude conversation context';
  if (status === 'tool') return 'Claude is using a tool';
  return status ? `Claude status: ${status}` : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function keyFor(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}
