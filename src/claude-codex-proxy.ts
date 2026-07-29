#!/usr/bin/env node

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { pathToFileURL } from 'url';
import {
  ClaudeStreamDecoder,
  CopilotStreamDecoder,
  CursorStreamDecoder,
  GrokStreamDecoder,
  completeCodexToolItem,
  createCodexToolItem,
  failCodexToolItem,
  type ClaudeStreamUpdate,
} from './claude-stream.js';

type RequestId = string | number;
type ProviderModelId = 'cursor-agent' | 'copilot-agent';
type ExternalBackend = 'claude' | 'grok' | 'cursor' | 'copilot';
type ClaudeModelId = 'claude-fable'
  | 'claude-opus'
  | 'grok-4.5'
  | ProviderModelId
  | `cursor-agent::${string}`
  | `copilot-agent::${string}`;
type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface DiscoveredProviderModel {
  id: string;
  name: string;
  selectable?: boolean;
  unavailableReason?: string;
}

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
  model?: ClaudeModelId;
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
  nativeModel?: string | null;
  previousExternalModel?: ClaudeModelId | null;
  pendingModelChangeFrom?: string | null;
  modelChangeOverrides?: Record<string, string>;
  sharedHistory?: SharedHistoryMessage[];
  effort: ClaudeEffort;
  serviceTier: string | null;
  sessionId: string;
  hasStartedSession: boolean;
  sessions?: Partial<Record<ExternalBackend, ThreadSessionState>>;
  cwd: string;
  turns: SyntheticTurn[];
}

interface ThreadSessionState {
  sessionId: string;
  hasStartedSession: boolean;
  historyMessageCount?: number;
}

interface SharedHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  model: string | null;
}

interface ActiveNativeTurn {
  prompt: string;
  model: string;
  response: string;
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
const GROK_CLI = process.env.ATTUNE_GROK_CLI_PATH || 'grok';
const CURSOR_CLI = process.env.ATTUNE_CURSOR_CLI_PATH || 'cursor-agent';
const COPILOT_CLI = process.env.ATTUNE_COPILOT_CLI_PATH || 'copilot';
const FALLBACK_CODEX_MODEL = process.env.ATTUNE_CLAUDE_FALLBACK_CODEX_MODEL || 'gpt-5.6-terra';
const STATE_PATH = process.env.ATTUNE_CLAUDE_CODEX_STATE_PATH
  || join(homedir(), '.attune', 'claude-codex-proxy.json');
const PENDING_NEW_THREAD_ID = '00000000-0000-4000-8000-000000000001';
let nestedModelCatalogPromise: Promise<Record<ProviderModelId, Array<Record<string, unknown>>>> | null = null;
const modelDisplayNames = new Map<string, string>();
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
  'grok-4.5': {
    id: 'grok-4.5',
    model: 'grok-4.5',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Grok 4.5',
    description: 'Grok 4.5 through the local Grok CLI.',
    hidden: false,
    supportedReasoningEfforts: grokEffortOptions(),
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
  'cursor-agent': {
    id: 'cursor-agent',
    model: 'cursor-agent',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Cursor',
    description: 'Cursor through the local Cursor CLI and your configured Cursor model.',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
  },
  'copilot-agent': {
    id: 'copilot-agent',
    model: 'copilot-agent',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Copilot',
    description: 'Copilot CLI using its configured or automatically selected model.',
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

function grokEffortOptions(): Array<Record<string, string>> {
  return [
    { reasoningEffort: 'low', description: 'Quick, fast implementations' },
    { reasoningEffort: 'medium', description: 'Balanced implementation and testing' },
    { reasoningEffort: 'high', description: 'Highest implementation quality and reasoning' },
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
  const activeNativeTurns = new Map<string, ActiveNativeTurn>();
  let pendingNewThreadSelection: {
    model: ClaudeModelId;
    effort: ClaudeEffort;
    serviceTier: string | null;
  } | null = null;
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

    if (method === 'attune/external-model/state' && requestKey) {
      const threadId = asString(params.threadId);
      const threadState = threadId ? state.threads[threadId] : pendingNewThreadSelection;
      pending.delete(requestKey);
      sendClient({
        id: message.id,
        result: externalModelState(threadId, threadState),
      });
      return;
    }

    if (
      method === 'thread/settings/update'
      && requestKey
      && asString(params.threadId) === PENDING_NEW_THREAD_ID
    ) {
      const selectedModel = claudeModel(params.model);
      pendingNewThreadSelection = selectedModel
        ? {
            model: selectedModel,
            effort: claudeEffort(params.effort) ?? defaultEffort(selectedModel),
            serviceTier: asString(params.serviceTier),
          }
        : null;
      pending.delete(requestKey);
      sendClient({ id: message.id, result: {} });
      return;
    }

    if (method === 'turn/start' && requestKey) {
      const threadId = asString(params.threadId);
      const requestedModel = claudeModel(params.model);
      const threadState = threadId ? state.threads[threadId] : undefined;
      // The ChatGPT renderer can expose only a client-new-thread placeholder
      // even for an existing task. In that case the picker queues an explicit
      // Attune selection without a UUID. Bind it to the next real turn id.
      const queuedSelection = pendingNewThreadSelection;
      if (threadId && queuedSelection) pendingNewThreadSelection = null;
      // A turn can carry a stale picker value because ChatGPT updates its own
      // model state asynchronously. It is execution input, not a second model
      // authority. Once a task has state, run exactly that committed selection.
      const selectedModel = queuedSelection?.model
        ?? (threadState ? threadState.model : requestedModel);
      if (threadId && selectedModel) {
        const effort = queuedSelection?.effort
          ?? threadState?.effort
          ?? claudeEffort(params.effort)
          ?? defaultEffort(selectedModel);
        const serviceTier = queuedSelection?.serviceTier
          ?? threadState?.serviceTier
          ?? asString(params.serviceTier);
        const nextState = threadState ?? createThreadState(selectedModel, effort, serviceTier, asString(params.cwd));
        const previousModel = threadSelectionModel(nextState);
        activateThreadModel(nextState, selectedModel);
        if (previousModel && previousModel !== selectedModel) {
          nextState.pendingModelChangeFrom = previousModel;
        }
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
      const requestedModel = claudeModel(params.model);
      const queuedSelection = pendingNewThreadSelection;
      pendingNewThreadSelection = null;
      const selectedModel = queuedSelection?.model ?? requestedModel;
      if (selectedModel) {
        const effectiveParams = queuedSelection && selectedModel === queuedSelection.model
          ? {
              ...params,
              model: selectedModel,
              effort: queuedSelection.effort,
              serviceTier: queuedSelection.serviceTier,
              attuneExternalSelection: true,
            }
          : params;
        pending.set(requestKey, { method, params: effectiveParams, selectedModel });
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
        const authoritative = params.attuneExternalSelection === true;
        const effectiveModel = !authoritative
          && existing.model
          && providerModelName(existing.model)
          && parentProviderModel(existing.model) === selectedModel
            ? existing.model
            : selectedModel;
        const previousModel = threadSelectionModel(existing);
        activateThreadModel(existing, effectiveModel);
        if (previousModel && previousModel !== effectiveModel) {
          existing.pendingModelChangeFrom = previousModel;
        }
        existing.effort = effort;
        existing.serviceTier = asString(params.serviceTier);
        state.threads[threadId] = existing;
        writeState(state);
        sendExternalThreadSettingsUpdated(threadId, existing);
        message = {
          ...message,
          params: { ...params, model: FALLBACK_CODEX_MODEL },
        };
      } else if (threadId && typeof params.model === 'string') {
        const effort = claudeEffort(params.effort) ?? 'medium';
        const existing = state.threads[threadId] ?? createNativeThreadState(
          params.model,
          effort,
          asString(params.serviceTier),
          null,
        );
        const previousModel = threadSelectionModel(existing);
        deactivateThreadModel(existing);
        existing.nativeModel = params.model;
        if (previousModel && previousModel !== params.model) {
          existing.pendingModelChangeFrom = previousModel;
        }
        existing.effort = effort;
        existing.serviceTier = asString(params.serviceTier);
        state.threads[threadId] = existing;
        writeState(state);
      }
    }

    if (method === 'turn/start') {
      const threadId = asString(params.threadId);
      const nativeModel = asString(params.model);
      if (threadId && nativeModel) {
        activeNativeTurns.set(threadId, {
          prompt: extractPrompt(params.input),
          model: nativeModel,
          response: '',
        });
      }
    }

    sendServer(message);
  });

  serverLines.on('line', async line => {
    let message: ProtocolMessage;
    let sourceRequest: PendingRequest | undefined;
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
        sourceRequest = request;
        pending.delete(requestKey);
        await rewriteResponse(message, request, state);
      }
    } else {
      rewriteNotification(message, state);
    }
    const historyChanged = captureNativeHistory(
      message,
      sourceRequest,
      state,
      activeNativeTurns,
    );
    const modelHistoryChanged = rewriteModelChangedItems(message, sourceRequest, state);
    if (historyChanged || modelHistoryChanged) writeState(state);
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

  function sendExternalThreadSettingsUpdated(
    threadId: string,
    threadState: ClaudeThreadState,
  ): void {
    if (!threadState.model) return;
    sendClient({
      method: 'thread/settings/updated',
      params: {
        threadId,
        threadSettings: {
          model: parentProviderModel(threadState.model),
          modelProvider: null,
          effort: threadState.effort,
          serviceTier: threadState.serviceTier ?? 'default',
          collaborationMode: {
            mode: 'default',
            settings: {
              model: threadState.model,
              reasoning_effort: threadState.effort,
              developer_instructions: null,
            },
          },
          cwd: threadState.cwd || homedir(),
        },
      },
    });
  }

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
    const providerPrompt = promptWithSharedHistory(
      input.threadState,
      input.model,
      prompt,
    );
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

    const invocationItemId = `external_${randomUUID().replaceAll('-', '')}`;
    const invocationStartedAtMs = Date.now();
    const invocationItem = {
      type: 'mcpToolCall',
      id: invocationItemId,
      server: providerName(input.model),
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
      message: `Starting local ${providerName(input.model)} session`,
    });

    try {
      invocationResult = await invokeAgent(input, turnId, providerPrompt, handleStreamUpdate);
      finalText = invocationResult.finalText;
      failureMessage = invocationResult.isError
        ? invocationResult.errorMessage ?? `${providerName(input.model)} returned an error.`
        : null;
      if (!failureMessage && invocationResult.sessionId) {
        updateActiveThreadSession(input.threadState, invocationResult.sessionId, true);
      }
    } catch (error) {
      stopped = (error as Error).message === 'External model request stopped.';
      failureMessage = stopped ? null : friendlyCliError(error as Error, input.model);
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
      model: input.model,
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
    input.threadState.pendingModelChangeFrom = null;
    if (turnStatus === 'completed' && prompt && finalText) {
      const history = ensureSharedHistory(input.threadState);
      history.push(
        { role: 'user', text: prompt, model: input.model },
        { role: 'assistant', text: finalText, model: input.model },
      );
      markActiveSessionHistorySynced(input.threadState, history.length);
    }
    writeState(input.state);
    if (turnStatus === 'completed' && prompt && finalText) {
      injectHistory(input.threadId, prompt, finalText);
    }

    function handleStreamUpdate(update: ClaudeStreamUpdate): void {
      if (update.type === 'session') {
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

  function invokeAgent(
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
    const invocation = cliInvocation(input, prompt);
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
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
      const decoder = input.model === 'grok-4.5'
        ? new GrokStreamDecoder()
        : input.model === 'cursor-agent' || input.model.startsWith('cursor-agent::')
          ? new CursorStreamDecoder()
          : input.model === 'copilot-agent' || input.model.startsWith('copilot-agent::')
            ? new CopilotStreamDecoder()
            : new ClaudeStreamDecoder();
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
            process.stderr.write(`[attune] ${providerName(input.model)} stream translation error: ${(error as Error).message}\n`);
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
          reject(new Error(`${providerName(input.model)} request timed out after 15 minutes.`));
          return;
        }
        if (signal === 'SIGTERM') {
          reject(new Error('External model request stopped.'));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `${providerName(input.model)} exited with status ${code}`));
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
        resolve(result);
      });
    });
  }
}

async function rewriteResponse(message: ProtocolMessage, request: PendingRequest, state: ProxyState): Promise<void> {
  if (message.error || !message.result) return;
  if (request.method === 'model/list') {
    const data = message.result.data;
    if (Array.isArray(data)) {
      for (const model of data) {
        const record = asRecord(model);
        const id = asString(record?.id) || asString(record?.model);
        const name = asString(record?.displayName);
        if (id && name) modelDisplayNames.set(id, name);
      }
      const withoutDuplicates = data.filter(model => {
        const id = asString((model as Record<string, unknown>)?.id);
        return !id || !claudeModel(id);
      });
      const nestedModels = await nestedModelCatalog();
      // Keep submodels addressable by Attune without placing them in the
      // top-level picker. Their native label is intentionally unprefixed:
      // the provider row and collapsed picker add the provider exactly once.
      const hiddenNestedModels = Object.values(nestedModels)
        .flat()
        .filter(model => model.id !== 'cursor-agent' && model.id !== 'copilot-agent')
        .map(model => {
          const id = asString(model.id);
          const providerPrefix = id?.startsWith('cursor-agent::')
            ? 'Cursor · '
            : id?.startsWith('copilot-agent::')
              ? 'Copilot · '
              : '';
          return {
            ...model,
            displayName: `${providerPrefix}${
              asString(model.displayName) || id || 'Model'
            }`,
            hidden: true,
          };
        });
      message.result.data = [
        ...withoutDuplicates,
        CLAUDE_MODELS['claude-fable'],
        CLAUDE_MODELS['claude-opus'],
        CLAUDE_MODELS['grok-4.5'],
        {
          ...CLAUDE_MODELS['cursor-agent'],
          attuneNestedModels: nestedModels['cursor-agent'],
          attuneSupportsPendingNewThreadSelection: true,
        },
        {
          ...CLAUDE_MODELS['copilot-agent'],
          attuneNestedModels: nestedModels['copilot-agent'],
          attuneSupportsPendingNewThreadSelection: true,
        },
        ...hiddenNestedModels,
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
    message.result.model = parentProviderModel(request.selectedModel);
    message.result.reasoningEffort = effort;
    message.result.serviceTier = threadState.serviceTier ?? 'default';
    return;
  }
  if (request.method === 'thread/start') {
    const thread = asRecord(message.result.thread);
    const threadId = asString(thread?.id);
    const nativeModel = asString(request.params.model);
    if (threadId && nativeModel) {
      state.threads[threadId] = createNativeThreadState(
        nativeModel,
        claudeEffort(request.params.effort) ?? 'medium',
        asString(request.params.serviceTier),
        asString(message.result.cwd) ?? asString(request.params.cwd),
      );
      writeState(state);
    }
    return;
  }
  if (request.method === 'thread/resume') {
    const thread = asRecord(message.result.thread);
    const threadId = asString(thread?.id);
    const threadState = threadId ? state.threads[threadId] : undefined;
    if (threadState?.model) {
      message.result.model = parentProviderModel(threadState.model);
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
  settings.model = parentProviderModel(threadState.model);
  settings.effort = threadState.effort;
  settings.serviceTier = threadState.serviceTier ?? 'default';
  const collaborationMode = asRecord(settings.collaborationMode);
  const collaborationSettings = asRecord(collaborationMode?.settings);
  if (collaborationSettings) {
    collaborationSettings.model = threadState.model;
    collaborationSettings.reasoning_effort = threadState.effort;
  }
}

function rewriteModelChangedItems(
  message: ProtocolMessage,
  request: PendingRequest | undefined,
  state: ProxyState,
): boolean {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  const threadId = asString(params?.threadId)
    || asString(request?.params.threadId)
    || asString(resultThread?.id);
  const threadState = threadId ? state.threads[threadId] : undefined;
  if (!threadState) return false;
  let changed = false;
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const item = value as Record<string, unknown>;
    if (item.type === 'modelChanged') {
      const itemId = asString(item.id);
      const savedOverride = itemId
        ? threadState.modelChangeOverrides?.[itemId]
        : null;
      const externalModel = savedOverride
        || (!threadState.model
          ? threadState.pendingModelChangeFrom || threadState.previousExternalModel
          : null);
      if (externalModel && item.fromModel !== externalModel) {
        item.fromModel = externalModel;
        changed = true;
      }
      if (
        externalModel
        && itemId
        && threadState.modelChangeOverrides?.[itemId] !== externalModel
      ) {
        threadState.modelChangeOverrides ??= {};
        threadState.modelChangeOverrides[itemId] = externalModel;
        changed = true;
      }
    }
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(message);
  const resultTurn = asRecord(result?.turn);
  if (
    !threadState.model
    && (threadState.pendingModelChangeFrom || threadState.previousExternalModel)
    && (
      message.method === 'turn/completed'
      || resultTurn?.status === 'completed'
    )
  ) {
    threadState.previousExternalModel = null;
    threadState.pendingModelChangeFrom = null;
    changed = true;
  }
  return changed;
}

function captureNativeHistory(
  message: ProtocolMessage,
  request: PendingRequest | undefined,
  state: ProxyState,
  activeNativeTurns: Map<string, ActiveNativeTurn>,
): boolean {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  const threadId = asString(params?.threadId) || asString(request?.params.threadId);
  if (!threadId) return false;
  const active = activeNativeTurns.get(threadId);
  if (!active) return false;
  if (message.error) {
    activeNativeTurns.delete(threadId);
    return false;
  }
  if (message.method === 'item/agentMessage/delta') {
    active.response += asString(params?.delta) || '';
  }
  const completedItem = asRecord(params?.item);
  if (message.method === 'item/completed' && completedItem?.type === 'agentMessage') {
    const text = asString(completedItem.text);
    if (text && (completedItem.phase === 'final_answer' || !active.response)) {
      active.response = text;
    }
  }
  const resultTurn = asRecord(result?.turn);
  const completedTurn = message.method === 'turn/completed'
    ? asRecord(params?.turn)
    : resultTurn?.status === 'completed'
      ? resultTurn
      : null;
  if (!completedTurn) return false;
  const finalText = finalAgentMessageText(completedTurn) || active.response;
  const threadState = state.threads[threadId] ?? createNativeThreadState(
    active.model,
    'medium',
    null,
    null,
  );
  state.threads[threadId] = threadState;
  activeNativeTurns.delete(threadId);
  if (!active.prompt || !finalText) return false;
  ensureSharedHistory(threadState).push(
    { role: 'user', text: active.prompt, model: active.model },
    { role: 'assistant', text: finalText, model: active.model },
  );
  return true;
}

function finalAgentMessageText(value: unknown): string {
  const final: string[] = [];
  const fallback: string[] = [];
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    if (Array.isArray(entry)) {
      for (const nested of entry) visit(nested);
      return;
    }
    const item = entry as Record<string, unknown>;
    if (item.type === 'agentMessage') {
      const text = asString(item.text);
      if (text) {
        fallback.push(text);
        if (item.phase === 'final_answer') final.push(text);
      }
    }
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return final.at(-1) || fallback.at(-1) || '';
}

function createThreadState(
  model: ClaudeModelId,
  effort: ClaudeEffort,
  serviceTier: string | null,
  cwd: string | null,
): ClaudeThreadState {
  const session = {
    sessionId: randomUUID(),
    hasStartedSession: false,
  };
  return {
    model,
    nativeModel: null,
    previousExternalModel: null,
    pendingModelChangeFrom: null,
    modelChangeOverrides: {},
    sharedHistory: [],
    effort,
    serviceTier,
    sessionId: session.sessionId,
    hasStartedSession: session.hasStartedSession,
    sessions: {
      [backendForModel(model)]: {
        ...session,
        historyMessageCount: 0,
      },
    },
    cwd: cwd || homedir(),
    turns: [],
  };
}

function createNativeThreadState(
  model: string,
  effort: ClaudeEffort,
  serviceTier: string | null,
  cwd: string | null,
): ClaudeThreadState {
  return {
    model: null,
    nativeModel: model,
    previousExternalModel: null,
    pendingModelChangeFrom: null,
    modelChangeOverrides: {},
    sharedHistory: [],
    effort,
    serviceTier,
    sessionId: randomUUID(),
    hasStartedSession: false,
    sessions: {},
    cwd: cwd || homedir(),
    turns: [],
  };
}

function activateThreadModel(threadState: ClaudeThreadState, model: ClaudeModelId): void {
  const sessions = ensureThreadSessions(threadState);
  if (threadState.model) {
    const previousBackend = backendForModel(threadState.model);
    sessions[previousBackend] = {
      ...sessions[previousBackend],
      sessionId: threadState.sessionId,
      hasStartedSession: threadState.hasStartedSession,
    };
  }
  const backend = backendForModel(model);
  const session = sessions[backend] ?? {
    sessionId: randomUUID(),
    hasStartedSession: false,
    historyMessageCount: 0,
  };
  sessions[backend] = session;
  threadState.model = model;
  threadState.nativeModel = null;
  threadState.previousExternalModel = null;
  threadState.sessionId = session.sessionId;
  threadState.hasStartedSession = session.hasStartedSession;
}

function deactivateThreadModel(threadState: ClaudeThreadState): void {
  const sessions = ensureThreadSessions(threadState);
  if (threadState.model) {
    threadState.previousExternalModel = threadState.model;
    const previousBackend = backendForModel(threadState.model);
    sessions[previousBackend] = {
      ...sessions[previousBackend],
      sessionId: threadState.sessionId,
      hasStartedSession: threadState.hasStartedSession,
    };
  }
  threadState.model = null;
  threadState.sessionId = randomUUID();
  threadState.hasStartedSession = false;
}

function updateActiveThreadSession(
  threadState: ClaudeThreadState,
  sessionId: string,
  hasStartedSession: boolean,
): void {
  threadState.sessionId = sessionId;
  threadState.hasStartedSession = hasStartedSession;
  if (threadState.model) {
    const sessions = ensureThreadSessions(threadState);
    const backend = backendForModel(threadState.model);
    sessions[backend] = {
      ...sessions[backend],
      sessionId,
      hasStartedSession,
    };
  }
}

function ensureThreadSessions(
  threadState: ClaudeThreadState,
): Partial<Record<ExternalBackend, ThreadSessionState>> {
  if (!threadState.sessions) {
    threadState.sessions = {};
    // Legacy scalar sessions are safe to migrate only when their originating
    // external model is still known. A null model may hold any provider's ID.
    if (threadState.model) {
      threadState.sessions[backendForModel(threadState.model)] = {
        sessionId: threadState.sessionId,
        hasStartedSession: threadState.hasStartedSession,
        historyMessageCount: undefined,
      };
    }
  }
  const historyLength = ensureSharedHistory(threadState).length;
  for (const [backend, session] of Object.entries(threadState.sessions)) {
    if (!session || session.historyMessageCount !== undefined) continue;
    // Older provider sessions do not know which turns they have seen. Start a
    // fresh CLI session once and seed it from the shared transcript so history
    // is complete without duplicating an unknown provider-local context.
    session.sessionId = randomUUID();
    session.hasStartedSession = false;
    session.historyMessageCount = 0;
    if (
      threadState.model
      && backendForModel(threadState.model) === backend
    ) {
      threadState.sessionId = session.sessionId;
      threadState.hasStartedSession = false;
    }
  }
  return threadState.sessions;
}

function markActiveSessionHistorySynced(
  threadState: ClaudeThreadState,
  historyMessageCount: number,
): void {
  if (!threadState.model) return;
  const sessions = ensureThreadSessions(threadState);
  const backend = backendForModel(threadState.model);
  const session = sessions[backend];
  if (!session) return;
  session.historyMessageCount = historyMessageCount;
}

function promptWithSharedHistory(
  threadState: ClaudeThreadState,
  model: ClaudeModelId,
  prompt: string,
): string {
  const history = ensureSharedHistory(threadState);
  const sessions = ensureThreadSessions(threadState);
  const session = sessions[backendForModel(model)];
  const syncedCount = Math.max(
    0,
    Math.min(session?.historyMessageCount ?? 0, history.length),
  );
  const updates = history.slice(syncedCount);
  if (!updates.length) return prompt;
  const transcript = updates.map(message => {
    const modelName = message.model ? historyModelName(message.model) : '';
    const speaker = message.role === 'user'
      ? 'User'
      : modelName
        ? `Assistant (${modelName})`
        : 'Assistant';
    return `${speaker}: ${message.text}`;
  }).join('\n\n');
  const boundedTranscript = transcript.length > 80_000
    ? `[Earlier transcript truncated]\n${transcript.slice(-80_000)}`
    : transcript;
  return [
    'Conversation updates from turns handled outside this CLI session follow.',
    'Treat them as earlier conversation context. Do not answer them separately.',
    '<attune_conversation_history>',
    boundedTranscript,
    '</attune_conversation_history>',
    '',
    'Current user request:',
    prompt,
  ].join('\n');
}

function ensureSharedHistory(threadState: ClaudeThreadState): SharedHistoryMessage[] {
  if (Array.isArray(threadState.sharedHistory)) return threadState.sharedHistory;
  threadState.sharedHistory = [...threadState.turns]
    .sort((left, right) => left.startedAt - right.startedAt)
    .flatMap(turn => sharedHistoryFromSyntheticTurn(turn));
  return threadState.sharedHistory;
}

function sharedHistoryFromSyntheticTurn(turn: SyntheticTurn): SharedHistoryMessage[] {
  const prompt = turn.items
    .filter(item => item.type === 'userMessage')
    .map(item => extractPrompt(item.content))
    .filter(Boolean)
    .join('\n');
  const response = turn.items
    .filter(item => item.type === 'agentMessage' && item.phase === 'final_answer')
    .map(item => asString(item.text))
    .filter((text): text is string => Boolean(text))
    .at(-1) || finalAgentMessageText(turn.items);
  return [
    ...(prompt ? [{ role: 'user' as const, text: prompt, model: turn.model || null }] : []),
    ...(response
      ? [{ role: 'assistant' as const, text: response, model: turn.model || null }]
      : []),
  ];
}

function historyModelName(model: string): string {
  const external = claudeModel(model);
  return external
    ? displayName(external)
    : modelDisplayNames.get(model) || humanizeModelName(model);
}

function threadSelectionModel(threadState: ClaudeThreadState): string | null {
  return threadState.model || threadState.nativeModel || null;
}

function backendForModel(model: ClaudeModelId): ExternalBackend {
  if (model === 'grok-4.5') return 'grok';
  if (model === 'cursor-agent' || model.startsWith('cursor-agent::')) return 'cursor';
  if (model === 'copilot-agent' || model.startsWith('copilot-agent::')) return 'copilot';
  return 'claude';
}

function readState(): ProxyState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as ProxyState;
    if (parsed.version === 1 && parsed.threads && typeof parsed.threads === 'object') {
      for (const threadId of Object.keys(parsed.threads)) {
        if (
          threadId === PENDING_NEW_THREAD_ID
          || threadId.startsWith('__attune_')
          || threadId.startsWith('client-new-thread:')
        ) {
          delete parsed.threads[threadId];
        }
      }
      return parsed;
    }
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
  if (
    value === 'claude-fable'
    || value === 'claude-opus'
    || value === 'grok-4.5'
    || value === 'cursor-agent'
    || value === 'copilot-agent'
  ) return value;
  if (
    typeof value === 'string'
    && (value.startsWith('cursor-agent::') || value.startsWith('copilot-agent::'))
    && providerModelName(value)
  ) return value as ClaudeModelId;
  return null;
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
  return model === 'claude-opus' || model === 'grok-4.5' ? 'high' : 'medium';
}

function exactModelName(model: ClaudeModelId): string {
  if (model === 'claude-fable') return 'claude-fable-5';
  if (model === 'claude-opus') return 'claude-opus-5';
  if (model === 'grok-4.5') return 'grok-4.5';
  const nested = providerModelName(model);
  if (nested) return nested;
  if (model === 'copilot-agent') return 'auto';
  return 'auto';
}

function displayName(model: ClaudeModelId): string {
  if (model === 'claude-fable') return 'Claude Fable 5';
  if (model === 'claude-opus') return 'Claude Opus 5';
  if (model === 'grok-4.5') return 'Grok 4.5';
  const nested = providerModelName(model);
  if (nested) return `${providerName(model)} · ${humanizeModelName(nested)}`;
  if (model === 'copilot-agent') return 'Copilot';
  return 'Cursor';
}

function externalModelState(
  threadId: string | null,
  selection: Pick<ClaudeThreadState, 'model' | 'nativeModel' | 'effort' | 'serviceTier'>
    | {
        model: ClaudeModelId;
        nativeModel?: null;
        effort: ClaudeEffort;
        serviceTier: string | null;
      }
    | null
    | undefined,
): Record<string, unknown> {
  const externalModel = selection?.model ?? null;
  const model = externalModel || selection?.nativeModel || null;
  const providerId = externalModel === 'cursor-agent'
    || externalModel?.startsWith('cursor-agent::')
    ? 'cursor-agent'
    : externalModel === 'copilot-agent'
      || externalModel?.startsWith('copilot-agent::')
      ? 'copilot-agent'
      : null;
  const nestedModel = externalModel ? providerModelName(externalModel) : null;
  return {
    threadId,
    model,
    externalModel,
    parentModel: externalModel ? parentProviderModel(externalModel) : model,
    providerId,
    displayName: externalModel
      ? nestedModel
        ? humanizeModelName(nestedModel)
        : providerId
          ? 'Auto'
          : displayName(externalModel)
      : model
        ? modelDisplayNames.get(model) || humanizeModelName(model)
      : null,
    effort: selection?.effort ?? null,
    serviceTier: selection?.serviceTier ?? null,
  };
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

function providerName(model: ClaudeModelId): string {
  if (model === 'grok-4.5') return 'Grok CLI';
  if (model === 'cursor-agent' || model.startsWith('cursor-agent::')) return 'Cursor';
  if (model === 'copilot-agent' || model.startsWith('copilot-agent::')) return 'Copilot';
  return 'Claude Code';
}

function parentProviderModel(model: ClaudeModelId): ClaudeModelId {
  if (model.startsWith('cursor-agent::')) return 'cursor-agent';
  if (model.startsWith('copilot-agent::')) return 'copilot-agent';
  return model;
}

function providerModelName(model: string): string | null {
  const separator = model.indexOf('::');
  if (separator < 0) return null;
  try {
    return decodeURIComponent(model.slice(separator + 2)) || null;
  } catch {
    return null;
  }
}

function cliInvocation(
  input: {
    effort: ClaudeEffort;
    model: ClaudeModelId;
    threadState: ClaudeThreadState;
  },
  prompt: string,
): { command: string; args: string[] } {
  if (input.model === 'grok-4.5') {
    return {
      command: GROK_CLI,
      args: [
        '--no-auto-update',
        '--output-format', 'streaming-json',
        '--model', exactModelName(input.model),
        '--effort', input.effort,
        '--yolo',
        '--rules', claudeBridgeInstructions(input.model),
        ...(input.threadState.hasStartedSession
          ? ['--resume', input.threadState.sessionId]
          : ['--session-id', input.threadState.sessionId]),
        '-p', prompt,
      ],
    };
  }
  if (input.model === 'cursor-agent' || input.model.startsWith('cursor-agent::')) {
    const selectedModel = providerModelName(input.model);
    return {
      command: CURSOR_CLI,
      args: [
        '--print',
        '--force',
        '--output-format', 'stream-json',
        '--model', selectedModel || 'auto',
        ...(input.threadState.hasStartedSession
          ? ['--resume', input.threadState.sessionId]
          : []),
        `${claudeBridgeInstructions(input.model)}\n\n${prompt}`,
      ],
    };
  }
  if (input.model === 'copilot-agent' || input.model.startsWith('copilot-agent::')) {
    const selectedModel = providerModelName(input.model);
    return {
      command: COPILOT_CLI,
      args: [
        '--no-auto-update',
        '--output-format', 'json',
        '--stream', 'on',
        '--allow-all',
        '--no-ask-user',
        '--model', selectedModel || 'auto',
        ...(selectedModel ? ['--effort', input.effort] : []),
        '--session-id', input.threadState.sessionId,
        '--prompt', `${claudeBridgeInstructions(input.model)}\n\n${prompt}`,
      ],
    };
  }
  return {
    command: CLAUDE_CLI,
    args: [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', exactModelName(input.model),
      '--effort', input.effort,
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', 'AskUserQuestion',
      '--append-system-prompt', claudeBridgeInstructions(input.model),
      ...(input.threadState.hasStartedSession
        ? ['--resume', input.threadState.sessionId]
        : ['--session-id', input.threadState.sessionId]),
      prompt,
    ],
  };
}

async function nestedModelCatalog(): Promise<Record<ProviderModelId, Array<Record<string, unknown>>>> {
  nestedModelCatalogPromise ??= Promise.all([
    discoverCursorModels(),
    discoverCopilotModels(),
  ]).then(([cursor, copilot]) => ({
    'cursor-agent': providerModelEntries('cursor-agent', cursor, false),
    'copilot-agent': providerModelEntries('copilot-agent', copilot, true),
  }));
  return nestedModelCatalogPromise;
}

async function discoverCursorModels(): Promise<DiscoveredProviderModel[]> {
  const configured = configuredModels('ATTUNE_CURSOR_MODELS_JSON');
  if (configured) return configured;
  try {
    const [catalogOutput, aboutOutput] = await Promise.all([
      commandOutput(CURSOR_CLI, ['--list-models'], 30_000),
      commandOutput(CURSOR_CLI, ['about'], 30_000).catch(() => ''),
    ]);
    const subscriptionTier = parseCursorSubscriptionTier(aboutOutput);
    const namedModelsSelectable = subscriptionTier?.toLowerCase() !== 'free';
    return parseCursorModels(catalogOutput).map(model => ({
      ...model,
      selectable: namedModelsSelectable,
      unavailableReason: namedModelsSelectable
        ? undefined
        : 'Requires a paid Cursor plan.',
    }));
  } catch {
    return [];
  }
}

async function discoverCopilotModels(): Promise<DiscoveredProviderModel[]> {
  const configured = configuredModels('ATTUNE_COPILOT_MODELS_JSON');
  if (configured) return configured;
  try {
    const command = resolveCommandPath(COPILOT_CLI);
    if (!command) return [];
    const packageRoot = dirname(realpathSync(command));
    const platformPackage = `copilot-${process.platform}-${process.arch}`;
    const sdkPath = join(packageRoot, 'node_modules', '@github', platformPackage, 'sdk', 'index.js');
    if (!existsSync(sdkPath)) return [];
    const sdk = await import(pathToFileURL(sdkPath).href) as {
      getAvailableModels?: (authInfo: unknown) => Promise<unknown>;
      resolveAuthInfoFromToken?: (token: string) => Promise<unknown>;
    };
    if (
      typeof sdk.getAvailableModels !== 'function'
      || typeof sdk.resolveAuthInfoFromToken !== 'function'
    ) return [];
    const token = process.env.GH_TOKEN
      || process.env.GITHUB_TOKEN
      || (await commandOutput('gh', ['auth', 'token'])).trim();
    if (!token) return [];
    const authInfo = await sdk.resolveAuthInfoFromToken(token);
    const available = await sdk.getAvailableModels(authInfo);
    if (!Array.isArray(available)) return [];
    return available.flatMap(entry => {
      const model = asRecord(entry);
      const id = asString(model?.id);
      if (!id || id === 'auto') return [];
      return [{
        id,
        name: asString(model?.name)
          || asString(model?.displayName)
          || humanizeModelName(id),
      }];
    });
  } catch {
    // A generic help list can contain models that the authenticated account
    // cannot select explicitly. Auto is always injected separately and is the
    // only safe fallback when account-filtered discovery is unavailable.
    return [];
  }
}

function configuredModels(environmentKey: string): DiscoveredProviderModel[] | null {
  const value = process.env[environmentKey];
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap(entry => {
      if (typeof entry === 'string' && entry) {
        return [{ id: entry, name: humanizeModelName(entry) }];
      }
      const record = asRecord(entry);
      const id = asString(record?.id);
      return id ? [{
        id,
        name: asString(record?.name) || humanizeModelName(id),
        selectable: typeof record?.selectable === 'boolean' ? record.selectable : undefined,
        unavailableReason: asString(record?.unavailableReason) || undefined,
      }] : [];
    });
  } catch {
    return null;
  }
}

function parseCursorModels(output: string): DiscoveredProviderModel[] {
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const models: Array<{ id: string; name: string }> = [];
  for (const line of plain.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+-\s+(.+?)(?:\s+\([^)]*\))*$/);
    if (!match || match[1] === 'Available') continue;
    models.push({ id: match[1], name: match[2].trim() });
  }
  return models;
}

function parseCursorSubscriptionTier(output: string): string | null {
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  return plain.match(/^\s*Subscription Tier\s+(.+?)\s*$/mi)?.[1]?.trim() || null;
}

function providerModelEntries(
  provider: ProviderModelId,
  models: DiscoveredProviderModel[],
  supportsEffort: boolean,
): Array<Record<string, unknown>> {
  const entries = [{ id: 'auto', name: 'Auto' }, ...models.filter(model => model.id !== 'auto')];
  return entries.map(model => {
    const modelId = model.id === 'auto'
      ? provider
      : `${provider}::${encodeURIComponent(model.id)}`;
    return {
      id: modelId,
      model: modelId,
      displayName: model.name,
      description: `${model.name} through ${provider === 'cursor-agent' ? 'Cursor' : 'Copilot'}.`,
      supportedReasoningEfforts: supportsEffort ? effortOptions() : [],
      defaultReasoningEffort: supportsEffort ? 'medium' : null,
      isDefault: model.id === 'auto',
      attuneSelectable: model.id === 'auto' || model.selectable !== false,
      attuneUnavailableReason: model.id === 'auto'
        ? null
        : model.unavailableReason || null,
    };
  });
}

function humanizeModelName(value: string): string {
  return value
    .split('-')
    .map(part => {
      if (/^(gpt|glm)$/i.test(part)) return part.toUpperCase();
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part ? part[0].toUpperCase() + part.slice(1) : part;
    })
    .join(' ');
}

function resolveCommandPath(command: string): string | null {
  if (command.includes('/')) return existsSync(command) ? command : null;
  for (const directory of (process.env.PATH || '').split(':')) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function commandOutput(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout?.on('data', chunk => {
      if (stdout.length < 2_000_000) stdout += String(chunk);
    });
    child.stderr?.on('data', chunk => {
      if (stderr.length < 100_000) stderr += String(chunk);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function friendlyCliError(error: Error, model: ClaudeModelId): string {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    const executable = model === 'grok-4.5'
      ? GROK_CLI
      : model === 'cursor-agent' || model.startsWith('cursor-agent::')
        ? CURSOR_CLI
        : model === 'copilot-agent' || model.startsWith('copilot-agent::')
          ? COPILOT_CLI
        : CLAUDE_CLI;
    return `${providerName(model)} is not installed or could not be found at “${executable}”. Install and authenticate its CLI, then restart ChatGPT.`;
  }
  return error.message;
}

function statusMessage(status: string): string | null {
  if (status === 'requesting') return 'Waiting for model response';
  if (status === 'reasoning') return 'Model is reasoning';
  if (status === 'compacting') return 'Compacting conversation context';
  if (status === 'tool') return 'Model is using a tool';
  return status ? `Model status: ${status}` : null;
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
