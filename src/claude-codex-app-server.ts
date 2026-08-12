import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { ServerResponse } from 'node:http';
import {
  routingErrorCode,
  type RoutingDiagnostics,
} from './claude-gpt-diagnostics.js';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const CLIENT_NAME = 'attune_claude_bridge';
const CLIENT_TITLE = 'Attune Claude GPT Bridge';
const CLIENT_VERSION = '0.2.0';
const NEUTRAL_CWD = join(homedir(), '.attune', 'claude-codex-runtime');

export interface ClaudeCodexModelIdentity {
  displayName: string;
  upstreamModel: string;
}

export interface ClaudeCodexAppServerStatus {
  running: boolean;
  accountType: string | null;
  planType: string | null;
  availableModels: readonly string[];
  codexPath: string;
}

export interface ClaudeCodexAppServerOptions {
  codexPath?: string;
  diagnostics: RoutingDiagnostics;
  requiredModels: readonly string[];
  rpcTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export interface ClaudeCodexRequestTrace {
  requestId: string;
  modelAlias: string;
  upstreamModel: string;
  modelDisplayName: string;
  startedAt: number;
}

export interface ClaudeCodexAppServerHandle {
  status(): ClaudeCodexAppServerStatus;
  health(): boolean;
  respond(
    response: ServerResponse,
    requestPath: string,
    requestBody: Buffer,
    identity: ClaudeCodexModelIdentity,
    trace: ClaudeCodexRequestTrace,
    signal?: AbortSignal,
  ): Promise<void>;
  cleanup(): Promise<void>;
}

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

interface PendingRpc {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface HostTool {
  originalName: string;
  dynamicName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

interface ActiveGeneration {
  threadId: string;
  turnId: string | null;
  toolByDynamicName: Map<string, HostTool>;
  text: string;
  streamedItemIds: Set<string>;
  toolUse: ToolUse | null;
  builtInToolType: string | null;
  resolve(result: GenerationResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  onTextDelta(delta: string): void;
  onToolUse(toolUse: ToolUse): void;
}

interface GenerationResult {
  text: string;
  toolUse: ToolUse | null;
  status: string;
}

interface ParsedAnthropicRequest {
  model: string;
  stream: boolean;
  system: unknown;
  messages: unknown[];
  tools: HostTool[];
  maxTokens: number | null;
  toolChoice: unknown;
  stopSequences: string[];
}

interface AccountReadResult {
  account?: {
    type?: unknown;
    planType?: unknown;
  } | null;
  requiresOpenaiAuth?: unknown;
}

interface ModelListResult {
  data?: Array<{ id?: unknown }>;
}

interface ThreadStartResult {
  thread?: { id?: unknown };
}

interface TurnStartResult {
  turn?: { id?: unknown };
}

/**
 * Resolve the official Codex runtime without reading or copying its auth files.
 * Attune talks only to `codex app-server`; that process owns the managed login.
 */
export function resolveCodexAppServerPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = environment.ATTUNE_CODEX_APP_SERVER_PATH?.trim();
  const candidates = [
    explicit,
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(homedir(), 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
    ...(environment.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory, 'codex')),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (isNodeScript(candidate)) return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next installed Codex runtime.
    }
  }
  throw new Error(
    'Attune could not find an installed Codex runtime. Install or sign in to ChatGPT/Codex first.',
  );
}

export async function createClaudeCodexAppServer(
  options: ClaudeCodexAppServerOptions,
): Promise<ClaudeCodexAppServerHandle> {
  const client = new CodexAppServerClient(options);
  await client.start();
  return client.handle();
}

class CodexAppServerClient {
  private readonly codexPath: string;
  private readonly diagnostics: RoutingDiagnostics;
  private readonly requiredModels: readonly string[];
  private readonly rpcTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRpc>();
  private active = new Map<string, ActiveGeneration>();
  private stopping = false;
  private accountType: string | null = null;
  private planType: string | null = null;
  private availableModels: string[] = [];

  constructor(options: ClaudeCodexAppServerOptions) {
    this.codexPath = options.codexPath ?? resolveCodexAppServerPath();
    this.diagnostics = options.diagnostics;
    this.requiredModels = options.requiredModels;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    mkdirSync(NEUTRAL_CWD, { recursive: true, mode: 0o700 });
    const executable = isNodeScript(this.codexPath) ? process.execPath : this.codexPath;
    const args = isNodeScript(this.codexPath)
      ? [this.codexPath, 'app-server', '--stdio']
      : ['app-server', '--stdio'];
    const child = spawn(executable, args, {
      cwd: NEUTRAL_CWD,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.onLine(line));
    child.once('error', error => this.onExit(error));
    child.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `status ${code ?? 'unknown'}`;
      this.onExit(new Error(`The local Codex app-server exited with ${suffix}.`));
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: CLIENT_NAME,
          title: CLIENT_TITLE,
          version: CLIENT_VERSION,
        },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});

      const account = await this.request('account/read', {
        refreshToken: false,
      }) as AccountReadResult;
      if (!account.account) {
        throw new Error(
          'No local Codex login is available. Sign in once with ChatGPT/Codex, then relaunch Claude through Attune.',
        );
      }
      this.accountType = typeof account.account.type === 'string'
        ? account.account.type
        : 'unknown';
      this.planType = typeof account.account.planType === 'string'
        ? account.account.planType
        : null;

      const catalog = await this.request('model/list', {
        limit: 100,
        includeHidden: false,
      }) as ModelListResult;
      this.availableModels = (catalog.data ?? [])
        .map(model => typeof model.id === 'string' ? model.id : null)
        .filter((model): model is string => model !== null);
      const missing = this.requiredModels.filter(model => !this.availableModels.includes(model));
      if (missing.length > 0) {
        throw new Error(`The local Codex account does not expose required model(s): ${missing.join(', ')}.`);
      }
      this.diagnostics.write('proxy', 'codexAppServerReady', {
        accountType: this.accountType,
        planType: this.planType,
        modelCount: this.availableModels.length,
        requiredModels: [...this.requiredModels],
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  handle(): ClaudeCodexAppServerHandle {
    return {
      status: () => ({
        running: this.isRunning(),
        accountType: this.accountType,
        planType: this.planType,
        availableModels: Object.freeze([...this.availableModels]),
        codexPath: this.codexPath,
      }),
      health: () => this.isRunning(),
      respond: (response, requestPath, requestBody, identity, trace, signal) => (
        this.respond(response, requestPath, requestBody, identity, trace, signal)
      ),
      cleanup: () => this.stop(),
    };
  }

  private isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed && !this.stopping);
  }

  private async respond(
    response: ServerResponse,
    requestPath: string,
    requestBody: Buffer,
    identity: ClaudeCodexModelIdentity,
    trace: ClaudeCodexRequestTrace,
    signal?: AbortSignal,
  ): Promise<void> {
    let parsed: ParsedAnthropicRequest;
    try {
      parsed = parseAnthropicRequest(requestBody);
    } catch (error) {
      this.diagnostics.write('proxy', 'codexRequestRejected', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        errorCode: routingErrorCode(error),
      });
      sendAnthropicError(response, 400, 'invalid_request_error', 'The Claude request is invalid.');
      return;
    }

    if (requestPath === '/v1/messages/count_tokens') {
      const inputTokens = estimateTokens(requestBody.length);
      const body = Buffer.from(JSON.stringify({ input_tokens: inputTokens }));
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      response.end(body);
      this.diagnostics.write('proxy', 'codexTokenCountEstimated', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        inputTokens,
      });
      return;
    }

    const inputTokens = estimateTokens(requestBody.length);
    const writer = new AnthropicResponseWriter(
      response,
      parsed.model,
      parsed.stream,
      inputTokens,
    );
    let started = false;
    try {
      const result = await this.generate(parsed, identity, {
        signal,
        onStarted: () => {
          started = true;
          writer.start();
        },
        onTextDelta: delta => writer.textDelta(delta),
        onToolUse: toolUse => writer.toolUse(toolUse),
      });
      writer.finish(result);
      this.diagnostics.write('proxy', 'codexResponseCompleted', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        upstreamModel: trace.upstreamModel,
        modelDisplayName: trace.modelDisplayName,
        durationMs: Date.now() - trace.startedAt,
        responseBytes: writer.bytesWritten(),
        responseMode: parsed.stream ? 'stream' : 'json',
        stopReason: result.toolUse ? 'toolUse' : 'endTurn',
      });
    } catch (error: unknown) {
      this.diagnostics.write('proxy', 'codexResponseFailed', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        upstreamModel: trace.upstreamModel,
        modelDisplayName: trace.modelDisplayName,
        durationMs: Date.now() - trace.startedAt,
        errorCode: routingErrorCode(error),
        headersSent: response.headersSent,
      });
      if (started || response.headersSent) writer.fail('The local Codex request failed.');
      else sendAnthropicError(
        response,
        502,
        'api_error',
        safeCodexErrorMessage(error),
      );
    }
  }

  private async generate(
    request: ParsedAnthropicRequest,
    identity: ClaudeCodexModelIdentity,
    handlers: {
      signal?: AbortSignal;
      onStarted(): void;
      onTextDelta(delta: string): void;
      onToolUse(toolUse: ToolUse): void;
    },
  ): Promise<GenerationResult> {
    if (!this.isRunning()) throw new Error('The local Codex app-server is not running.');
    if (!this.availableModels.includes(identity.upstreamModel)) {
      throw new Error(`The local Codex account does not expose ${identity.upstreamModel}.`);
    }

    const dynamicTools = request.tools.map(tool => ({
      type: 'function',
      name: tool.dynamicName,
      description: `${tool.description}\nHost tool name: ${tool.originalName}`.trim(),
      inputSchema: tool.inputSchema,
    }));
    const thread = await this.request('thread/start', {
      model: identity.upstreamModel,
      cwd: NEUTRAL_CWD,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: CLIENT_NAME,
      baseInstructions: buildBaseInstructions(request, identity),
      developerInstructions: buildDeveloperInstructions(request),
      config: { web_search: 'disabled' },
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
    }) as ThreadStartResult;
    const threadId = typeof thread.thread?.id === 'string' ? thread.thread.id : null;
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');

    let generationResolve!: (result: GenerationResult) => void;
    let generationReject!: (error: Error) => void;
    const completion = new Promise<GenerationResult>((resolve, reject) => {
      generationResolve = resolve;
      generationReject = reject;
    });
    const timer = setTimeout(() => {
      const active = this.active.get(threadId);
      if (!active) return;
      this.active.delete(threadId);
      void this.interrupt(active);
      active.reject(new Error('The local Codex turn timed out.'));
    }, this.turnTimeoutMs);
    timer.unref();
    const active: ActiveGeneration = {
      threadId,
      turnId: null,
      toolByDynamicName: new Map(request.tools.map(tool => [tool.dynamicName, tool])),
      text: '',
      streamedItemIds: new Set(),
      toolUse: null,
      builtInToolType: null,
      resolve: generationResolve,
      reject: generationReject,
      timer,
      onTextDelta: handlers.onTextDelta,
      onToolUse: handlers.onToolUse,
    };
    this.active.set(threadId, active);

    const onAbort = () => {
      const current = this.active.get(threadId);
      if (!current) return;
      this.active.delete(threadId);
      clearTimeout(current.timer);
      void this.interrupt(current);
      current.reject(new Error('The Claude client cancelled the local Codex turn.'));
    };
    handlers.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const prompt = buildConversationInput(request);
      const input: Array<Record<string, unknown>> = [{ type: 'text', text: prompt.text }];
      input.push(...prompt.images.map(url => ({ type: 'image', url })));
      const turn = await this.request('turn/start', {
        threadId,
        input,
        model: identity.upstreamModel,
        effort: modelEffort(identity.upstreamModel),
        summary: 'none',
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          access: { type: 'fullAccess' },
        },
      }) as TurnStartResult;
      const turnId = typeof turn.turn?.id === 'string' ? turn.turn.id : null;
      if (!turnId) throw new Error('Codex app-server did not return a turn id.');
      active.turnId = turnId;
      handlers.onStarted();
      this.diagnostics.write('proxy', 'codexTurnStarted', {
        model: identity.upstreamModel,
        toolCount: request.tools.length,
        imageCount: prompt.images.length,
      });
      return await completion;
    } catch (error) {
      if (this.active.get(threadId) === active) {
        this.active.delete(threadId);
        clearTimeout(active.timer);
      }
      throw error;
    } finally {
      handlers.signal?.removeEventListener('abort', onAbort);
      void this.request('thread/unsubscribe', { threadId }).catch(() => {});
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.diagnostics.write('proxy', 'codexProtocolInvalidJson');
      return;
    }

    const key = message.id === undefined ? null : String(message.id);
    if (key !== null && !message.method) {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(jsonRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'item/tool/call' && key !== null) {
      this.onDynamicToolCall(key, message.params ?? {});
      return;
    }
    const threadId = stringField(message.params, 'threadId');
    if (!threadId) return;
    const active = this.active.get(threadId);
    if (!active) return;

    if (message.method === 'item/agentMessage/delta') {
      if (active.toolUse) return;
      const delta = stringField(message.params, 'delta') ?? '';
      const itemId = stringField(message.params, 'itemId');
      if (itemId) active.streamedItemIds.add(itemId);
      if (delta) {
        active.text += delta;
        active.onTextDelta(delta);
      }
      return;
    }
    if (message.method === 'item/completed') {
      const item = recordField(message.params, 'item');
      if (
        item?.type === 'agentMessage'
        && typeof item.id === 'string'
        && !active.streamedItemIds.has(item.id)
        && !active.toolUse
        && typeof item.text === 'string'
        && item.text
      ) {
        active.text += item.text;
        active.onTextDelta(item.text);
      }
      return;
    }
    if (message.method === 'item/started') {
      const item = recordField(message.params, 'item');
      if (item && isBuiltInToolItem(item.type)) {
        active.builtInToolType = String(item.type);
        void this.interrupt(active);
      }
      return;
    }
    if (message.method === 'turn/completed') {
      this.completeGeneration(active, recordField(message.params, 'turn'));
    }
  }

  private onDynamicToolCall(requestId: string, params: Record<string, unknown>): void {
    const threadId = stringField(params, 'threadId');
    const dynamicName = stringField(params, 'tool');
    const callId = stringField(params, 'callId');
    const active = threadId ? this.active.get(threadId) : null;
    const tool = dynamicName ? active?.toolByDynamicName.get(dynamicName) : null;
    if (!active || !tool || !callId) {
      this.reply(requestId, {
        contentItems: [{ type: 'inputText', text: 'The host tool is unavailable.' }],
        success: false,
      });
      return;
    }

    const toolUse: ToolUse = {
      id: anthropicToolUseId(callId),
      name: tool.originalName,
      input: params.arguments ?? {},
    };
    active.toolUse = toolUse;
    active.onToolUse(toolUse);
    this.reply(requestId, {
      contentItems: [{
        type: 'inputText',
        text: 'The Claude host accepted this tool call and will execute it outside Codex.',
      }],
      success: true,
    });
    this.diagnostics.write('proxy', 'codexDynamicToolSelected', {
      toolName: tool.originalName,
    });
    void this.interrupt(active);
  }

  private completeGeneration(
    active: ActiveGeneration,
    turn: Record<string, unknown> | null,
  ): void {
    if (this.active.get(active.threadId) !== active) return;
    this.active.delete(active.threadId);
    clearTimeout(active.timer);
    const status = typeof turn?.status === 'string' ? turn.status : 'unknown';
    if (active.toolUse) {
      active.resolve({ text: active.text, toolUse: active.toolUse, status });
      return;
    }
    if (active.builtInToolType) {
      active.reject(new Error(
        `Codex attempted its internal ${active.builtInToolType} tool instead of the Claude host tools.`,
      ));
      return;
    }
    if (status !== 'completed') {
      const error = recordField(turn, 'error');
      const message = typeof error?.message === 'string'
        ? error.message
        : `The local Codex turn ended with status ${status}.`;
      active.reject(new Error(message));
      return;
    }
    active.resolve({ text: active.text, toolUse: null, status });
  }

  private interrupt(active: ActiveGeneration): Promise<unknown> {
    if (!active.turnId || !this.isRunning()) return Promise.resolve({});
    return this.request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    }).catch(() => ({}));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.exitCode !== null) {
      return Promise.reject(new Error('The local Codex app-server is unavailable.'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server timed out during ${method}.`));
      }, this.rpcTimeoutMs);
      timer.unref();
      this.pending.set(String(id), { method, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(String(id));
        if (!pending) return;
        this.pending.delete(String(id));
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private reply(id: string, result: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    const numericId = /^\d+$/.test(id) ? Number(id) : id;
    child.stdin.write(`${JSON.stringify({ id: numericId, result })}\n`);
  }

  private onExit(error: Error): void {
    if (this.stopping) return;
    this.diagnostics.write('proxy', 'codexAppServerExited', {
      errorCode: routingErrorCode(error),
    });
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    this.active.clear();
  }

  private async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The local Codex app-server stopped.'));
    }
    this.pending.clear();
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      active.reject(new Error('The local Codex app-server stopped.'));
    }
    this.active.clear();
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolveStop => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolveStop();
      }, 2_000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  }
}

class AnthropicResponseWriter {
  private readonly response: ServerResponse;
  private readonly model: string;
  private readonly stream: boolean;
  private readonly inputTokens: number;
  private readonly messageId = `msg_attune_${randomUUID().replaceAll('-', '')}`;
  private started = false;
  private ended = false;
  private activeBlock: 'text' | 'tool' | null = null;
  private nextBlockIndex = 0;
  private content: Array<Record<string, unknown>> = [];
  private byteCount = 0;

  constructor(
    response: ServerResponse,
    model: string,
    stream: boolean,
    inputTokens: number,
  ) {
    this.response = response;
    this.model = model;
    this.stream = stream;
    this.inputTokens = inputTokens;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.stream) return;
    this.response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
    });
    this.event('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  textDelta(delta: string): void {
    if (!delta || this.ended) return;
    this.start();
    const last = this.content.at(-1);
    if (last?.type === 'text') last.text = `${String(last.text ?? '')}${delta}`;
    else this.content.push({ type: 'text', text: delta });
    if (!this.stream) return;
    if (this.activeBlock !== 'text') {
      this.closeBlock();
      this.activeBlock = 'text';
      this.event('content_block_start', {
        type: 'content_block_start',
        index: this.nextBlockIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.nextBlockIndex,
      delta: { type: 'text_delta', text: delta },
    });
  }

  toolUse(toolUse: ToolUse): void {
    if (this.ended) return;
    this.start();
    this.content.push({
      type: 'tool_use',
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    });
    if (!this.stream) return;
    this.closeBlock();
    this.activeBlock = 'tool';
    this.event('content_block_start', {
      type: 'content_block_start',
      index: this.nextBlockIndex,
      content_block: {
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: {},
      },
    });
    this.event('content_block_delta', {
      type: 'content_block_delta',
      index: this.nextBlockIndex,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(toolUse.input ?? {}),
      },
    });
  }

  finish(result: GenerationResult): void {
    if (this.ended) return;
    this.start();
    if (this.content.length === 0) this.textDelta(result.text || '');
    const stopReason = result.toolUse ? 'tool_use' : 'end_turn';
    const outputTokens = estimateTokens(Buffer.byteLength(JSON.stringify(this.content)));
    if (this.stream) {
      this.closeBlock();
      this.event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      this.event('message_stop', { type: 'message_stop' });
      this.response.end();
    } else {
      const body = Buffer.from(JSON.stringify({
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: this.content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: outputTokens,
        },
      }));
      this.byteCount += body.length;
      this.response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      this.response.end(body);
    }
    this.ended = true;
  }

  fail(message: string): void {
    if (this.ended || this.response.destroyed) return;
    if (!this.stream || !this.response.headersSent) {
      sendAnthropicError(this.response, 502, 'api_error', message);
      this.ended = true;
      return;
    }
    this.closeBlock();
    this.event('error', {
      type: 'error',
      error: { type: 'api_error', message },
    });
    this.response.end();
    this.ended = true;
  }

  bytesWritten(): number {
    return this.byteCount;
  }

  private closeBlock(): void {
    if (!this.stream || this.activeBlock === null) return;
    this.event('content_block_stop', {
      type: 'content_block_stop',
      index: this.nextBlockIndex,
    });
    this.activeBlock = null;
    this.nextBlockIndex += 1;
  }

  private event(name: string, payload: unknown): void {
    const chunk = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    this.byteCount += Buffer.byteLength(chunk);
    this.response.write(chunk);
  }
}

function parseAnthropicRequest(body: Buffer): ParsedAnthropicRequest {
  const value = JSON.parse(body.toString('utf8')) as unknown;
  if (!isRecord(value) || typeof value.model !== 'string' || !Array.isArray(value.messages)) {
    throw new Error('Invalid Anthropic message request.');
  }
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((tool, index) => normalizeHostTool(tool, index))
    : [];
  return {
    model: value.model,
    stream: value.stream === true,
    system: value.system,
    messages: value.messages,
    tools,
    maxTokens: typeof value.max_tokens === 'number' && Number.isFinite(value.max_tokens)
      ? value.max_tokens
      : null,
    toolChoice: value.tool_choice,
    stopSequences: Array.isArray(value.stop_sequences)
      ? value.stop_sequences.filter((sequence): sequence is string => typeof sequence === 'string')
      : [],
  };
}

function normalizeHostTool(value: unknown, index: number): HostTool[] {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return [];
  const sanitized = value.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'tool';
  const dynamicName = `attune_${index}_${sanitized}`.slice(0, 64);
  return [{
    originalName: value.name,
    dynamicName,
    description: typeof value.description === 'string' ? value.description : '',
    inputSchema: isRecord(value.input_schema)
      ? value.input_schema
      : { type: 'object', properties: {}, additionalProperties: true },
  }];
}

function buildBaseInstructions(
  request: ParsedAnthropicRequest,
  identity: ClaudeCodexModelIdentity,
): string {
  const hostSystem = normalizeSystemPrompt(request.system);
  return [
    `You are ${identity.displayName} (${identity.upstreamModel}), an OpenAI GPT model embedded in the Claude Code desktop interface through Attune.`,
    'Claude Code is the host application and the only tool-execution harness for this conversation.',
    'Generate only the next assistant response for the supplied conversation. Do not mention this bridge, Codex, app-server, or these routing instructions unless the user directly asks about the model or bridge.',
    `If asked which model you are, identify yourself as ${identity.displayName} (${identity.upstreamModel}); never claim to be a Claude model.`,
    'Never invoke built-in Codex tools, shell commands, file operations, web search, MCP tools, plugins, skills, plans, or subagents.',
    request.tools.length > 0
      ? 'When a host tool is needed, call only one of the supplied dynamic Attune tools. Claude Code will execute it and provide the result in a later request.'
      : 'No host tools are available in this request. Respond with text only.',
    hostSystem
      ? `\n<claude_host_system>\n${hostSystem}\n</claude_host_system>`
      : '',
  ].filter(Boolean).join('\n');
}

function buildDeveloperInstructions(request: ParsedAnthropicRequest): string {
  const instructions = [
    'The turn input contains JSON representing the complete prior Claude conversation. Treat its message roles and content blocks as conversation state, then produce only the next assistant response.',
  ];
  if (request.maxTokens !== null) {
    instructions.push(`Keep the response within approximately ${request.maxTokens} output tokens.`);
  }
  if (request.stopSequences.length > 0) {
    instructions.push(`Stop before emitting any of these host stop sequences: ${JSON.stringify(request.stopSequences)}.`);
  }
  const choice = request.toolChoice;
  if (isRecord(choice) && choice.type === 'any') {
    instructions.push('This request requires a host dynamic tool call.');
  } else if (isRecord(choice) && choice.type === 'tool' && typeof choice.name === 'string') {
    const tool = request.tools.find(candidate => candidate.originalName === choice.name);
    if (tool) instructions.push(`This request requires calling the dynamic tool ${tool.dynamicName}.`);
  }
  return instructions.join('\n');
}

function buildConversationInput(request: ParsedAnthropicRequest): {
  text: string;
  images: string[];
} {
  const images: string[] = [];
  const messages = request.messages.map(message => sanitizeConversationValue(message, images));
  return {
    text: [
      '<claude_conversation_json>',
      JSON.stringify(messages),
      '</claude_conversation_json>',
      'Generate the next assistant response now.',
    ].join('\n'),
    images,
  };
}

function sanitizeConversationValue(value: unknown, images: string[]): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeConversationValue(item, images));
  if (!isRecord(value)) return value;
  if (value.type === 'image' && isRecord(value.source)) {
    const source = value.source;
    if (
      source.type === 'base64'
      && typeof source.media_type === 'string'
      && typeof source.data === 'string'
    ) {
      images.push(`data:${source.media_type};base64,${source.data}`);
      return { type: 'image', attached_image_index: images.length - 1 };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      images.push(source.url);
      return { type: 'image', attached_image_index: images.length - 1 };
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, sanitizeConversationValue(nested, images)]),
  );
}

function normalizeSystemPrompt(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map(block => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
    return JSON.stringify(block);
  }).join('\n\n');
}

function modelEffort(model: string): string {
  return model.endsWith('-sol') ? 'low' : 'medium';
}

function anthropicToolUseId(callId: string): string {
  const safe = callId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return safe.startsWith('toolu_') ? safe : `toolu_attune_${safe || randomUUID().replaceAll('-', '')}`;
}

function isBuiltInToolItem(type: unknown): boolean {
  return typeof type === 'string' && new Set([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'collabAgentToolCall',
    'webSearch',
    'imageView',
    'imageGeneration',
  ]).has(type);
}

function estimateTokens(byteLength: number): number {
  return Math.max(1, Math.ceil(byteLength / 4));
}

function jsonRpcError(method: string, value: unknown): Error {
  if (isRecord(value)) {
    const message = typeof value.message === 'string' ? value.message : 'Unknown JSON-RPC error';
    const error = new Error(`Codex app-server ${method} failed: ${message}`) as Error & { code?: string };
    if (typeof value.code === 'number' || typeof value.code === 'string') {
      error.code = `rpc_${value.code}`;
    }
    return error;
  }
  return new Error(`Codex app-server ${method} failed.`);
}

function safeCodexErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/No local Codex login|does not expose|required model|could not find an installed Codex/i.test(message)) {
    return message;
  }
  return 'The local Codex runtime could not complete this request.';
}

function sendAnthropicError(
  response: ServerResponse,
  statusCode: number,
  type: string,
  message: string,
): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify({
    type: 'error',
    error: { type, message },
  }));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function stringField(
  record: Record<string, unknown> | undefined,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === 'string' ? value : null;
}

function recordField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): Record<string, unknown> | null {
  const value = record?.[field];
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeScript(path: string): boolean {
  return /\.(?:cjs|mjs|js)$/i.test(path);
}
