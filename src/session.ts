import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { createServer } from 'net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { createCodexTaskFromChatGpt, type ChatGptCodexTransfer } from './codex-chatgpt.js';
import { ensureConfig, readStylesheet } from './config.js';
import { type DiscoveredApp, getAppExecutablePath, getAppId } from './scan.js';

const ATTUNE_DIR = join(homedir(), '.attune');
const SESSION_DIR = join(ATTUNE_DIR, 'sessions');
const WORKSPACE_BRIDGE_PATH = join(ATTUNE_DIR, 'workspace-bridge.json');
const WORKSPACE_BRIDGE_PORT = 47655;
const CLAUDE_BRIDGE_TOKEN_KEY = 'claude-code-token';
const activeClaudeProcesses = new Map<string, ChildProcess>();
const STYLE_ELEMENT_ID = 'attune-custom-stylesheet';
const WORKSPACE_SCRIPT_RE = /\/\*\s*@attune-script\s*\n([\s\S]*?)\n\s*@end-attune-script\s*\*\//g;
const WORKSPACE_BINDINGS_RE = /\/\*\s*@attune-bindings\s*\n([\s\S]*?)\n\s*@end-attune-bindings\s*\*\//g;
const POLL_INTERVAL_MS = 500;
const MAX_MISSED_POLLS = 120;
const RUNTIME_STATE_VERIFY_INTERVAL_MS = 5000;
const SESSION_HEARTBEAT_INTERVAL_MS = 5000;
const INSPECTION_TTL_MS = 24 * 60 * 60 * 1000;
const INSPECTION_TEMP_PREFIX = 'attune-inspect-';

const WORKSPACE_SOURCE_HASH_KEY = '__attuneWorkspaceSourceHash';
const WORKSPACE_STYLE_HASH_KEY = '__attuneWorkspaceStyleHash';
const WORKSPACE_SCRIPT_HASH_KEY = '__attuneWorkspaceScriptHash';
const WORKSPACE_BINDINGS_HASH_KEY = '__attuneWorkspaceBindingsHash';
const WORKSPACE_BRIDGE_HASH_KEY = '__attuneWorkspaceBridgeHash';
const HOST_MAPPER_VERSION = 2;
const HOST_MAPPER_VERSION_KEY = '__attuneHostMapperVersion';

interface DebugTarget {
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface DevToolsCommandResult<T> {
  id?: number;
  result?: T;
  error?: { message?: string };
  method?: string;
}

interface RuntimeState {
  sourceHash: string | null;
  styleHash: string | null;
  styleElementHash: string | null;
  scriptHash: string | null;
  bindingsHash: string | null;
  bridgeHash: string | null;
  mapperVersion: number | null;
}

export interface DevToolsCommandTransport {
  send<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

export interface SessionRecord {
  appId: string;
  appPath: string;
  appPid?: number;
  port: number;
  status: 'starting' | 'attached' | 'waiting' | 'stopped';
  targetCount: number;
  updatedAt: string;
  watcherPid: number;
}

export interface InspectionElement {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  tag: string;
  role: string | null;
  label: string;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  styles: {
    display: string;
    position: string;
    color: string;
    backgroundColor: string;
    fontSize: string;
  };
}

export interface PageInspection {
  title: string;
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  screenshotPath: string;
  attuneStylePresent: boolean;
  elements: InspectionElement[];
}

export interface AppInspection {
  appId: string;
  appName: string;
  capturedAt: string;
  inspectionPath: string;
  ephemeral: boolean;
  expiresAt: string | null;
  session: Pick<SessionRecord, 'status' | 'port' | 'targetCount'>;
  pages: PageInspection[];
}

export interface HostBinding {
  name: string;
  role: string;
  required: boolean;
}

export interface HostBindingSet {
  schemaVersion: number;
  attunementId: string;
  appName: string;
  bindings: HostBinding[];
}

export async function launch(app: DiscoveredApp, cliPath: string): Promise<{ port: number }> {
  const appId = getAppId(app);
  const configPath = ensureConfig(appId);
  const sessionPath = getSessionPath(appId);
  const executablePath = getAppExecutablePath(app);
  if (!existsSync(executablePath)) {
    throw new Error(`Could not find the app executable at ${executablePath}`);
  }
  if (isProcessRunning(executablePath)) {
    throw new Error(`"${app.name}" is already running. Quit it, then run Attune launch again.`);
  }

  stopSession(appId);
  const port = await getAvailablePort();
  const watcher = spawn(process.execPath, [cliPath, '_watch', configPath, String(port), sessionPath], {
    detached: true,
    stdio: 'ignore',
  });
  watcher.unref();

  const chromeProfilePath = app.runtime === 'chrome'
    ? join(ATTUNE_DIR, 'chrome-profiles', appId)
    : null;
  if (chromeProfilePath) mkdirSync(chromeProfilePath, { recursive: true });
  const launchEnvironment = shouldEnableClaudeCodexProxy(app.bundleId)
    ? ensureClaudeCodexProxyEnvironment(cliPath, executablePath)
    : process.env;
  const appProcess = spawn(executablePath, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=http://localhost',
    ...(chromeProfilePath ? [`--user-data-dir=${chromeProfilePath}`, '--no-first-run', '--no-default-browser-check'] : []),
  ], {
    cwd: dirname(executablePath),
    detached: true,
    env: launchEnvironment,
    stdio: 'ignore',
  });
  appProcess.unref();

  writeSession(sessionPath, {
    appId,
    appPath: app.path,
    appPid: appProcess.pid,
    port,
    status: 'starting',
    targetCount: 0,
    updatedAt: new Date().toISOString(),
    watcherPid: watcher.pid ?? 0,
  });

  return { port };
}

export function shouldEnableClaudeCodexProxy(
  bundleId: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return bundleId === 'com.openai.codex'
    && environment.ATTUNE_CLAUDE_CODEX_PROXY_ENABLED === '1';
}

function ensureClaudeCodexProxyEnvironment(
  cliPath: string,
  chatGptExecutablePath: string,
): NodeJS.ProcessEnv {
  const proxyModulePath = join(dirname(cliPath), 'claude-codex-proxy.js');
  const realCodexPath = join(dirname(dirname(chatGptExecutablePath)), 'Resources', 'codex');
  if (!existsSync(proxyModulePath) || !existsSync(realCodexPath)) return process.env;

  const binRoot = join(ATTUNE_DIR, 'bin');
  const proxyPath = join(binRoot, 'codex-claude-proxy');
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(proxyPath, [
    '#!/bin/sh',
    `exec ${shellQuote(process.execPath)} ${shellQuote(proxyModulePath)} "$@"`,
    '',
  ].join('\n'), { mode: 0o700 });
  chmodSync(proxyPath, 0o700);
  return {
    ...process.env,
    ATTUNE_CLAUDE_CLI_PATH: resolveClaudeCliPath(),
    ATTUNE_GROK_CLI_PATH: resolveExternalCliPath(
      'ATTUNE_GROK_CLI_PATH',
      'grok',
      [join(homedir(), '.local', 'bin', 'grok'), '/opt/homebrew/bin/grok', '/usr/local/bin/grok'],
    ),
    ATTUNE_CURSOR_CLI_PATH: resolveExternalCliPath(
      'ATTUNE_CURSOR_CLI_PATH',
      'cursor-agent',
      [
        join(homedir(), '.local', 'bin', 'cursor-agent'),
        join(homedir(), '.cursor', 'bin', 'cursor-agent'),
        '/opt/homebrew/bin/cursor-agent',
        '/usr/local/bin/cursor-agent',
      ],
    ),
    ATTUNE_COPILOT_CLI_PATH: resolveExternalCliPath(
      'ATTUNE_COPILOT_CLI_PATH',
      'copilot',
      [join(homedir(), '.local', 'bin', 'copilot'), '/opt/homebrew/bin/copilot', '/usr/local/bin/copilot'],
    ),
    ATTUNE_REAL_CODEX_CLI_PATH: realCodexPath,
    CODEX_CLI_PATH: proxyPath,
  };
}

function resolveExternalCliPath(
  environmentKey: string,
  command: string,
  extraCandidates: string[],
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment[environmentKey]) return environment[environmentKey]!;
  const candidates = [
    ...(environment.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, command)),
    ...extraCandidates,
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? command;
}

export function resolveClaudeCliPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.ATTUNE_CLAUDE_CLI_PATH) return environment.ATTUNE_CLAUDE_CLI_PATH;

  const candidates = [
    ...(environment.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'claude')),
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? 'claude';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Attach a watcher to an app that is already running with remote debugging enabled. */
export function attach(app: DiscoveredApp, cliPath: string, port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid remote debugging port: ${port}`);
  }

  const appId = getAppId(app);
  const configPath = ensureConfig(appId);
  const sessionPath = getSessionPath(appId);
  stopSession(appId);

  const watcher = spawn(process.execPath, [cliPath, '_watch', configPath, String(port), sessionPath], {
    detached: true,
    stdio: 'ignore',
  });
  watcher.unref();

  writeSession(sessionPath, {
    appId,
    appPath: app.path,
    port,
    status: 'starting',
    targetCount: 0,
    updatedAt: new Date().toISOString(),
    watcherPid: watcher.pid ?? 0,
  });
}

export function stopSession(appId: string): boolean {
  const sessionPath = getSessionPath(appId);
  const session = readSession(sessionPath);
  if (!session) return false;

  if (session.watcherPid > 0) {
    try {
      process.kill(session.watcherPid, 'SIGTERM');
    } catch {
      // A stale session is safe to remove.
    }
  }

  rmSync(sessionPath, { force: true });
  return true;
}

export function getSession(appId: string): SessionRecord | null {
  return readSession(getSessionPath(appId));
}

/**
 * Give an agent a bounded view of the live renderer: a screenshot, viewport,
 * and visible selector candidates. This is intentionally not a full DOM dump.
 */
export async function inspect(
  app: DiscoveredApp,
  outputDirectory?: string,
): Promise<AppInspection> {
  const appId = getAppId(app);
  const session = getSession(appId);
  if (!session) {
    throw new Error(`No Attune session is running for "${app.name}". Launch or attach it first.`);
  }
  if (session.status !== 'attached') {
    throw new Error(`Attune for "${app.name}" is ${session.status}; wait for status "attached" and try again.`);
  }

  const targets = (await getDebugTargets(session.port))
    .filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
  if (targets.length === 0) {
    throw new Error(`No inspectable page targets are available for "${app.name}".`);
  }

  cleanupExpiredInspections();
  const ephemeral = !outputDirectory;
  const resolvedOutputDirectory = outputDirectory ?? mkdtempSync(join(tmpdir(), INSPECTION_TEMP_PREFIX));
  mkdirSync(resolvedOutputDirectory, { recursive: true });
  const capturedAt = new Date().toISOString();
  const prefix = `${slugify(app.name)}-${capturedAt.replace(/[:.]/g, '-')}`;
  const pages: PageInspection[] = [];

  for (const [index, target] of targets.entries()) {
    const webSocketUrl = target.webSocketDebuggerUrl!;
    const evaluated = await sendDevToolsCommand<{
      result?: { value?: Omit<PageInspection, 'screenshotPath'> };
      exceptionDetails?: unknown;
    }>(webSocketUrl, 'Runtime.evaluate', {
      expression: buildInspectionExpression(),
      returnByValue: true,
    });
    if (evaluated.exceptionDetails || !evaluated.result?.value) continue;

    const screenshot = await sendDevToolsCommand<{ data?: string }>(
      webSocketUrl,
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true },
    );
    if (!screenshot.data) continue;

    const screenshotPath = join(resolvedOutputDirectory, `${prefix}-page-${index + 1}.png`);
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    pages.push({
      ...evaluated.result.value,
      title: evaluated.result.value.title || target.title || '',
      url: evaluated.result.value.url || target.url || '',
      screenshotPath,
    });
  }

  if (pages.length === 0) {
    throw new Error(`Attune could not capture an inspectable page for "${app.name}".`);
  }

  const inspectionPath = join(resolvedOutputDirectory, 'inspection.json');
  const result: AppInspection = {
    appId,
    appName: app.name,
    capturedAt,
    inspectionPath,
    ephemeral,
    expiresAt: ephemeral ? new Date(Date.now() + INSPECTION_TTL_MS).toISOString() : null,
    session: {
      status: session.status,
      port: session.port,
      targetCount: session.targetCount,
    },
    pages,
  };
  writeFileSync(inspectionPath, JSON.stringify(result, null, 2));
  return result;
}

export function compactInspection(inspection: AppInspection) {
  const primaryPage = [...inspection.pages].sort((left, right) => right.elements.length - left.elements.length)[0];
  const compactElements = primaryPage.elements
    .filter(element => element.stability !== 'low' || element.label || element.text)
    .slice(0, 24)
    .map(({ selector, stability, tag, role, label, text, bounds }) => ({
      selector,
      stability,
      tag,
      role,
      label: label.slice(0, 80),
      text: text.slice(0, 80),
      bounds,
    }));
  return {
    appId: inspection.appId,
    appName: inspection.appName,
    capturedAt: inspection.capturedAt,
    session: inspection.session,
    artifacts: {
      fullInspectionPath: inspection.inspectionPath,
      ephemeral: inspection.ephemeral,
      expiresAt: inspection.expiresAt,
      retention: inspection.ephemeral
        ? 'Temporary; automatically removed by a later inspection after expiry.'
        : 'Persistent because --output was supplied.',
    },
    pageCount: inspection.pages.length,
    primaryPage: {
      title: primaryPage.title,
      url: primaryPage.url,
      viewport: primaryPage.viewport,
      screenshotPath: primaryPage.screenshotPath,
      attuneStylePresent: primaryPage.attuneStylePresent,
      elementCount: primaryPage.elements.length,
      selectorSample: compactElements,
    },
    otherPages: inspection.pages
      .filter(page => page !== primaryPage)
      .map(page => ({
        title: page.title,
        url: page.url,
        viewport: page.viewport,
        screenshotPath: page.screenshotPath,
        elementCount: page.elements.length,
      })),
  };
}

function cleanupExpiredInspections(): void {
  const cutoff = Date.now() - INSPECTION_TTL_MS;
  let entries;
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(INSPECTION_TEMP_PREFIX)) continue;
    const candidate = join(tmpdir(), entry.name);
    try {
      if (statSync(candidate).mtimeMs < cutoff) rmSync(candidate, { recursive: true, force: true });
    } catch {
      // A concurrent cleanup or OS temp cleanup is harmless.
    }
  }
}

export async function runWatcher(configPath: string, port: number, sessionPath: string): Promise<void> {
  let stopped = false;
  let missedPolls = 0;
  let lastPublishedStatus: SessionRecord['status'] | null = null;
  let lastPublishedTargetCount = -1;
  let lastPublishedAt = 0;
  const targetSessions = new Map<string, TargetStylesheetSession>();
  const stopWorkspaceBridgeServer = startWorkspaceBridgeServer();

  const stop = () => {
    stopped = true;
    for (const targetSession of targetSessions.values()) targetSession.close();
    targetSessions.clear();
    stopWorkspaceBridgeServer();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const publishSession = (status: SessionRecord['status'], targetCount: number) => {
    const now = Date.now();
    if (
      status === lastPublishedStatus
      && targetCount === lastPublishedTargetCount
      && now - lastPublishedAt < SESSION_HEARTBEAT_INTERVAL_MS
    ) return;
    lastPublishedStatus = status;
    lastPublishedTargetCount = targetCount;
    lastPublishedAt = now;
    updateSession(sessionPath, {
      status,
      targetCount,
      updatedAt: new Date(now).toISOString(),
    });
  };

  const getTargetSession = (webSocketUrl: string): TargetStylesheetSession => {
    const existing = targetSessions.get(webSocketUrl);
    if (existing) return existing;

    let targetSession: TargetStylesheetSession | undefined;
    const connection = new PersistentDevToolsConnection(
      webSocketUrl,
      () => targetSession?.invalidate(),
      () => {
        if (targetSession && targetSessions.get(webSocketUrl) === targetSession) {
          targetSessions.delete(webSocketUrl);
        }
      },
    );
    targetSession = new TargetStylesheetSession(connection);
    targetSessions.set(webSocketUrl, targetSession);
    return targetSession;
  };

  try {
    while (!stopped) {
      try {
        const targets = await getDebugTargets(port);
        const stylesheet = readStylesheet(configPath);
        const pageTargets = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);
        const activeTargetUrls = new Set(pageTargets.map(target => target.webSocketDebuggerUrl!));

        for (const [webSocketUrl, targetSession] of targetSessions) {
          if (activeTargetUrls.has(webSocketUrl)) continue;
          targetSession.close();
          targetSessions.delete(webSocketUrl);
        }

        const workspaceBridge = readWorkspaceBridgeStore();
        const syncResults = await Promise.allSettled(pageTargets.map(target => (
          getTargetSession(target.webSocketDebuggerUrl!).sync(stylesheet, workspaceBridge)
        )));
        const attachedCount = syncResults.filter(result => result.status === 'fulfilled').length;
        if (pageTargets.length > 0 && attachedCount === 0) {
          throw new Error('Attune could not synchronize any renderer targets.');
        }

        missedPolls = 0;
        publishSession('attached', attachedCount);
      } catch {
        missedPolls += 1;
        publishSession('waiting', 0);
      }

      if (missedPolls >= MAX_MISSED_POLLS) {
        rmSync(sessionPath, { force: true });
        return;
      }

      await delay(POLL_INTERVAL_MS);
    }
  } finally {
    stop();
  }
}

class PersistentDevToolsConnection implements DevToolsCommandTransport {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private nextCommandId = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly webSocketUrl: string,
    private readonly onInvalidated: () => void,
    private readonly onClosed: () => void,
  ) {}

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 3000,
  ): Promise<T> {
    await this.ensureConnected();
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('DevTools connection is not open.');
    }

    const id = ++this.nextCommandId;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method} timed out`);
        reject(error);
        this.closeWithError(error);
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.socket!.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        const sendError = error instanceof Error ? error : new Error(String(error));
        reject(sendError);
        this.closeWithError(sendError);
      }
    });
  }

  close(): void {
    this.closeWithError(new Error('DevTools connection closed.'));
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('DevTools connection is closed.');
    if (this.socket?.readyState === 1) return;
    if (this.connecting) return await this.connecting;

    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(event));
    socket.addEventListener('close', () => {
      this.handleSocketClosed(socket, new Error('DevTools connection closed.'));
    }, { once: true });

    const connecting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DevTools connection timed out')), 3000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('DevTools connection failed'));
      }, { once: true });
    });
    this.connecting = connecting;
    try {
      await connecting;
    } catch (error) {
      try {
        socket.close();
      } catch {
        // Closing a socket that failed during connection is best effort.
      }
      this.handleSocketClosed(
        socket,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private handleMessage(event: MessageEvent): void {
    let message: DevToolsCommandResult<unknown>;
    try {
      message = JSON.parse(String(event.data)) as DevToolsCommandResult<unknown>;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'DevTools command failed'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      message.method === 'Runtime.executionContextsCleared'
      || message.method === 'Page.frameNavigated'
    ) this.onInvalidated();
  }

  private handleSocketClosed(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClosed();
  }

  private closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      socket?.close();
    } catch {
      // A renderer that already disappeared needs no further cleanup.
    }
    this.onClosed();
  }
}

export class TargetStylesheetSession {
  private initialized = false;
  private appliedSourceHash: string | null = null;
  private appliedBridgeHash: string | null = null;
  private invalidationVersion = 0;
  private lastVerifiedAt = 0;

  constructor(private readonly transport: DevToolsCommandTransport) {}

  async sync(
    stylesheet: string,
    workspaceBridge: Record<string, unknown>,
    now = Date.now(),
  ): Promise<void> {
    await this.initialize();
    const expected = getWorkspaceRuntimeState(stylesheet, workspaceBridge);

    if (this.appliedSourceHash !== expected.sourceHash) {
      await this.applySource(stylesheet, workspaceBridge, expected, now);
      return;
    }
    if (this.appliedBridgeHash !== expected.bridgeHash) {
      await this.applyBridge(workspaceBridge, expected.bridgeHash!, now);
      return;
    }
    if (now - this.lastVerifiedAt < RUNTIME_STATE_VERIFY_INTERVAL_MS) return;

    const remote = await this.readRuntimeState();
    this.lastVerifiedAt = now;
    if (!runtimeStatesMatch(remote, expected)) {
      await this.applySource(stylesheet, workspaceBridge, expected, now);
    }
  }

  invalidate(): void {
    this.invalidationVersion += 1;
    this.appliedSourceHash = null;
    this.appliedBridgeHash = null;
    this.lastVerifiedAt = 0;
  }

  close(): void {
    this.transport.close();
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.transport.send('Page.enable');
    await this.transport.send('Page.setBypassCSP', { enabled: true });
    this.initialized = true;
  }

  private async applySource(
    stylesheet: string,
    workspaceBridge: Record<string, unknown>,
    expected: RuntimeState,
    now: number,
  ): Promise<void> {
    const invalidationVersion = this.invalidationVersion;
    const response = await this.transport.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: buildStyleInjectionExpression(stylesheet, workspaceBridge),
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error('Attune source update failed in the renderer.');
    if (invalidationVersion !== this.invalidationVersion) return;
    this.appliedSourceHash = expected.sourceHash;
    this.appliedBridgeHash = expected.bridgeHash;
    this.lastVerifiedAt = now;
  }

  private async applyBridge(
    workspaceBridge: Record<string, unknown>,
    bridgeHash: string,
    now: number,
  ): Promise<void> {
    const invalidationVersion = this.invalidationVersion;
    const response = await this.transport.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: buildWorkspaceBridgeUpdateExpression(workspaceBridge),
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error('Attune bridge update failed in the renderer.');
    if (invalidationVersion !== this.invalidationVersion) return;
    this.appliedBridgeHash = bridgeHash;
    this.lastVerifiedAt = now;
  }

  private async readRuntimeState(): Promise<RuntimeState | null> {
    const response = await this.transport.send<{
      result?: { value?: RuntimeState };
    }>('Runtime.evaluate', {
      expression: buildRuntimeStateProbeExpression(),
      returnByValue: true,
    });
    return response.result?.value ?? null;
  }
}

function startWorkspaceBridgeServer(): () => void {
  ensureClaudeBridgeToken();
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createHttpServer((request, response) => {
    void handleWorkspaceBridgeRequest(request, response);
  });
  server.on('error', error => {
    if ('code' in error && error.code === 'EADDRINUSE') {
      if (!stopped && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (!stopped) server.listen(WORKSPACE_BRIDGE_PORT, '127.0.0.1');
        }, 1000);
        retryTimer.unref();
      }
      return;
    }
    console.warn('[attune] workspace bridge unavailable', error);
  });
  server.listen(WORKSPACE_BRIDGE_PORT, '127.0.0.1');
  server.unref();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (server.listening) server.close();
  };
}

function ensureClaudeBridgeToken(): void {
  const store = readWorkspaceBridgeStore();
  const existing = store[CLAUDE_BRIDGE_TOKEN_KEY] as { payload?: { token?: unknown } } | undefined;
  if (typeof existing?.payload?.token === 'string') return;
  store[CLAUDE_BRIDGE_TOKEN_KEY] = {
    updatedAt: new Date().toISOString(),
    payload: { token: randomUUID() },
  };
  writeWorkspaceBridgeStore(store);
}

async function handleWorkspaceBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Attune-Claude-Token');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const key = decodeURIComponent((request.url || '/').replace(/^\/v1\/?/, '').replace(/^\/+/, ''));
  if (!key || key.includes('/') || key.length > 120) {
    writeJson(response, 404, { error: 'Unknown workspace bridge key.' });
    return;
  }

  if (request.method === 'GET') {
    const store = readWorkspaceBridgeStore();
    writeJson(response, 200, store[key] ?? null);
    return;
  }

  if (request.method === 'POST') {
    const isFormHandoff = request.headers['content-type']?.includes('application/x-www-form-urlencoded') ?? false;
    try {
      const payload = await readRequestBody(request);
      if (key === 'chatgpt-to-codex') {
        const task = createCodexTaskFromChatGpt((payload || {}) as ChatGptCodexTransfer);
        const store = readWorkspaceBridgeStore();
        delete store[key];
        writeWorkspaceBridgeStore(store);
        if (isFormHandoff) {
          writeHandoffPage(response, 200, 'Opening Codex', `Opening “${task.title}”…`, true);
          scheduleCodexTaskOpen(task.threadId);
        } else {
          writeJson(response, 200, task);
        }
        return;
      }
      if (key === 'claude-code') {
        requireClaudeToken(request);
        writeJson(response, 200, await runClaudeCode(payload as Record<string, unknown>));
        return;
      }
      if (key === 'claude-code-cancel') {
        requireClaudeToken(request);
        const requestId = String((payload as { requestId?: unknown })?.requestId || '');
        const child = activeClaudeProcesses.get(requestId);
        child?.kill('SIGTERM');
        writeJson(response, 200, { cancelled: Boolean(child) });
        return;
      }

      const store = readWorkspaceBridgeStore();
      store[key] = {
        updatedAt: new Date().toISOString(),
        payload,
      };
      writeWorkspaceBridgeStore(store);
      writeJson(response, 200, store[key]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Attune could not process this request.';
      if (isFormHandoff) {
        writeHandoffPage(response, 400, 'Could not send to Codex', message, false);
      } else {
        writeJson(response, 400, { error: message });
      }
    }
    return;
  }

  writeJson(response, 405, { error: 'Unsupported method.' });
}

function requireClaudeToken(request: IncomingMessage): void {
  const expected = (readWorkspaceBridgeStore()[CLAUDE_BRIDGE_TOKEN_KEY] as { payload?: { token?: unknown } } | undefined)?.payload?.token;
  if (typeof expected !== 'string' || request.headers['x-attune-claude-token'] !== expected) {
    throw new Error('Unauthorized Claude Code request.');
  }
}

async function runClaudeCode(input: Record<string, unknown>): Promise<{ result: string; sessionId: string }> {
  const model = String(input.model || '');
  if (!['fable', 'opus'].includes(model)) throw new Error('Unsupported Claude model.');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || Buffer.byteLength(prompt) > 2 * 1024 * 1024) throw new Error('Claude prompt is empty or too large.');
  const requestId = String(input.requestId || '');
  if (!requestId) throw new Error('Missing Claude request identifier.');
  const sessionId = typeof input.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(input.sessionId)
    ? input.sessionId
    : randomUUID();
  const requestedCwd = String(input.cwd || '');
  const cwd = requestedCwd.startsWith('/') && existsSync(requestedCwd) ? requestedCwd : homedir();
  const args = [
    '--print', '--output-format', 'json',
    '--model', model,
    '--permission-mode', 'bypassPermissions',
    ...(input.resume === true ? ['--resume', sessionId] : ['--session-id', sessionId]),
    prompt,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.env.ATTUNE_CLAUDE_CLI_PATH || 'claude', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeClaudeProcesses.set(requestId, child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000);
    child.stdout?.on('data', chunk => { if (stdout.length < 8_000_000) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < 1_000_000) stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      activeClaudeProcesses.delete(requestId);
      if (code !== 0) return reject(new Error(stderr.trim() || `Claude Code exited with status ${code}.`));
      try {
        const response = JSON.parse(stdout) as { result?: unknown; session_id?: unknown };
        const result = String(response.result || '').trim();
        if (!result) throw new Error('Claude Code returned no response.');
        resolve({ result, sessionId: typeof response.session_id === 'string' ? response.session_id : sessionId });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function readWorkspaceBridgeStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(WORKSPACE_BRIDGE_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeWorkspaceBridgeStore(store: Record<string, unknown>): void {
  mkdirSync(dirname(WORKSPACE_BRIDGE_PATH), { recursive: true });
  writeAtomically(WORKSPACE_BRIDGE_PATH, store);
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error('The ChatGPT conversation is too large to import.');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  const body = Buffer.concat(chunks).toString('utf8');
  if (request.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    const payload = new URLSearchParams(body).get('payload');
    if (!payload) throw new Error('The Safari handoff did not include a conversation.');
    return JSON.parse(payload);
  }
  return JSON.parse(body);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function writeHandoffPage(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  closeAutomatically: boolean,
): void {
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  response.end(`<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>html{color-scheme:dark}body{display:grid;min-height:100vh;margin:0;place-items:center;background:#171717;color:#f5f5f5;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{max-width:360px;padding:24px;border:1px solid #3c3c3c;border-radius:14px;background:#242424;box-shadow:0 18px 60px #0008}h1{margin:0 0 8px;font-size:18px}p{margin:0;color:#b7b7b7}</style>
<main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
${closeAutomatically
    ? '<script>window.close()</script>'
    : '<script>window.resizeTo(440,240);window.moveTo(Math.max(0,(screen.availWidth-440)/2),Math.max(0,(screen.availHeight-240)/2));window.focus()</script>'}`);
}

function scheduleCodexTaskOpen(threadId: string): void {
  if (process.platform !== 'darwin') return;

  // Let Safari close the form-post popup before switching applications. If
  // Codex opens first, closing that popup can pull focus back to Safari.
  const timer = setTimeout(() => {
    try {
      const opener = spawn(
        '/usr/bin/open',
        ['-b', 'com.openai.codex', `codex://threads/${encodeURIComponent(threadId)}`],
        { detached: true, stdio: 'ignore' },
      );
      opener.unref();
    } catch (error) {
      console.warn('[attune] could not open the imported Codex task', error);
    }
  }, 350);
  timer.unref();
}

export function buildStyleInjectionExpression(css: string, workspaceBridge: Record<string, unknown> = {}): string {
  const workspaceSource = splitWorkspaceSource(css);
  const state = getWorkspaceRuntimeState(css, workspaceBridge);
  const safeCss = JSON.stringify(workspaceSource.css);
  const safeSourceHash = JSON.stringify(state.sourceHash);
  const safeStyleHash = JSON.stringify(state.styleHash);
  const safeScriptHash = JSON.stringify(state.scriptHash);
  const safeBindingsHash = JSON.stringify(state.bindingsHash);
  const safeBridgeHash = JSON.stringify(state.bridgeHash);
  const safeId = JSON.stringify(STYLE_ELEMENT_ID);
  const safeScript = JSON.stringify(workspaceSource.script);
  const safeBindingSets = JSON.stringify(workspaceSource.bindingSets);
  const safeWorkspaceBridge = JSON.stringify(workspaceBridge);
  const safeSourceHashKey = JSON.stringify(WORKSPACE_SOURCE_HASH_KEY);
  const safeStyleHashKey = JSON.stringify(WORKSPACE_STYLE_HASH_KEY);
  const safeScriptHashKey = JSON.stringify(WORKSPACE_SCRIPT_HASH_KEY);
  const safeBindingsHashKey = JSON.stringify(WORKSPACE_BINDINGS_HASH_KEY);
  const safeBridgeHashKey = JSON.stringify(WORKSPACE_BRIDGE_HASH_KEY);
  const safeMapperVersion = JSON.stringify(HOST_MAPPER_VERSION);
  const safeMapperVersionKey = JSON.stringify(HOST_MAPPER_VERSION_KEY);

  return `(() => {
  const id = ${safeId};
  const sourceHash = ${safeSourceHash};
  const styleHash = ${safeStyleHash};
  const scriptHash = ${safeScriptHash};
  const bindingsHash = ${safeBindingsHash};
  const bridgeHash = ${safeBridgeHash};
  const css = ${safeCss};
  const script = ${safeScript};
  const bindingSets = ${safeBindingSets};
  window.__attuneWorkspaceBridge = ${safeWorkspaceBridge};
  const cleanupKey = '__attuneWorkspaceScriptCleanup';
  const sourceHashKey = ${safeSourceHashKey};
  const styleHashKey = ${safeStyleHashKey};
  const scriptHashKey = ${safeScriptHashKey};
  const bindingsHashKey = ${safeBindingsHashKey};
  const bridgeHashKey = ${safeBridgeHashKey};
  const mapperVersion = ${safeMapperVersion};
  const mapperVersionKey = ${safeMapperVersionKey};
  const current = document.getElementById(id);
  const scriptChanged = window[scriptHashKey] !== scriptHash;
  const bindingsChanged = window[bindingsHashKey] !== bindingsHash;
  const mapperChanged = window[mapperVersionKey] !== mapperVersion;
  const mapperKey = '__attuneHostMapper';
  let status = 'current';
  if (bindingsChanged || mapperChanged) {
    try {
      window[mapperKey]?.cleanup?.();
    } catch (error) {
      console.warn('[attune] host mapper cleanup failed', error);
    }
    window[mapperKey] = undefined;
    window.__attuneHost = undefined;
    window.__attuneCompatibilityReports = {};
  }
  if (bindingSets.length && (bindingsChanged || mapperChanged || !window[mapperKey])) {
    const requestedRoles = new Set(bindingSets.flatMap(set => set.bindings.map(binding => binding.role)));
    const mappedElements = new Map();
    const listeners = new Set();
    let frame = 0;
    let disposed = false;

    const visible = element => {
      if (!element?.isConnected) return false;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && bounds.width > 0
        && bounds.height > 0;
    };
    const primaryChatScore = element => {
      let score = element.tagName === 'MAIN' ? 1 : 0;
      if (element.hasAttribute('data-app-shell-main-surface')) score += 6;
      if (element.classList.contains('main-surface')) score += 5;
      if (element.querySelector('[data-codex-composer-root]')) score += 4;
      if (element.querySelector('[data-app-action-timeline-scroll]')) score += 3;
      if (element.querySelector('button[aria-label="Chat actions"]')) score += 3;
      if (visible(element)) score += 1;
      return score;
    };
    const firstCandidate = (selector, root = document) => {
      const candidates = [...root.querySelectorAll(selector)];
      return candidates.find(visible) || candidates[0] || null;
    };
    const chatGptConversationScore = element => {
      let score = element.tagName === 'MAIN' || element.getAttribute('role') === 'main' ? 2 : 0;
      const messageCount = element.querySelectorAll(
        '[data-message-author-role], article[data-turn], [data-user-message-bubble]',
      ).length;
      if (messageCount) score += Math.min(8, messageCount);
      if (element.querySelector(
        '#prompt-textarea, form[data-type="unified-composer"], [data-lexical-editor="true"]',
      )) score += 3;
      if (visible(element)) score += 1;
      return score;
    };
    const resolveRole = role => {
      if (role === 'document.root') return document.documentElement;
      if (role === 'document.body') return document.body;
      if (role === 'codex.primaryChat') {
        return [...document.querySelectorAll('main')]
          .map(element => ({ element, score: primaryChatScore(element) }))
          .filter(candidate => candidate.score >= 8)
          .sort((left, right) => right.score - left.score)[0]?.element || null;
      }
      if (role === 'codex.composer') {
        const candidates = [...document.querySelectorAll('[data-codex-composer-root]')];
        return candidates.find(visible)
          || candidates[0]
          || document.querySelector('[data-codex-composer-root]');
      }
      if (role === 'codex.appShell') {
        const main = resolveRole('codex.primaryChat');
        const sidebar = resolveRole('codex.sidebar');
        return (main?.parentElement && (!sidebar || main.parentElement.contains(sidebar))
          ? main.parentElement
          : sidebar?.parentElement) || null;
      }
      if (role === 'codex.timeline') {
        const candidates = [...document.querySelectorAll('[data-app-action-timeline-scroll]')];
        return candidates.find(visible)
          || candidates[0]
          || document.querySelector('[data-app-action-timeline-scroll]');
      }
      if (role === 'codex.chatActions') {
        const candidates = [...document.querySelectorAll('button[aria-label="Chat actions"]')];
        return candidates.find(visible)
          || candidates[0]
          || document.querySelector('button[aria-label="Chat actions"]');
      }
      if (role === 'codex.chatHeader') {
        const action = resolveRole('codex.chatActions');
        return action?.closest('header')
          || document.querySelector('.app-header-tint')
          || null;
      }
      if (role === 'codex.sidebar') {
        return [...document.querySelectorAll('aside.app-shell-left-panel, aside')]
          .find(element => element.querySelector('[data-app-action-sidebar-scroll]') || visible(element))
          || null;
      }
      if (role === 'codex.sidebarThreads') {
        const sidebar = resolveRole('codex.sidebar');
        return sidebar?.querySelector('[data-app-action-sidebar-scroll]')
          || sidebar?.querySelector('nav')
          || sidebar
          || null;
      }
      if (role === 'codex.modelPicker') {
        const composer = resolveRole('codex.composer');
        return firstCandidate('[data-codex-intelligence-trigger]', composer || document)
          || firstCandidate('button[aria-haspopup="menu"]', composer || document);
      }
      if (role === 'chatgpt.conversation') {
        return [...document.querySelectorAll('main, [role="main"]')]
          .map(element => ({ element, score: chatGptConversationScore(element) }))
          .filter(candidate => candidate.score >= 3)
          .sort((left, right) => right.score - left.score)[0]?.element
          || null;
      }
      if (role === 'chatgpt.composer') {
        return firstCandidate([
          '#prompt-textarea',
          'form[data-type="unified-composer"] textarea',
          'form[data-type="unified-composer"] [contenteditable="true"]',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"][data-lexical-editor="true"]',
          'textarea',
        ].join(', '));
      }
      if (role === 'chatgpt.attachmentMenu') {
        return [...document.querySelectorAll(
          '[data-radix-popper-content-wrapper] .popover, div.popover, [role="menu"]',
        )].find(element => visible(element) && /Add photos|Attach|Upload/i.test(element.textContent || ''))
          || null;
      }
      if (role === 'linear.workspace') {
        return document.querySelector('[data-testid="app-shell"], #root, #app')
          || document.body;
      }
      if (role === 'linear.issueList') {
        const issueLink = firstCandidate('a[href*="/issue/"], a[href*="/team/"]');
        return issueLink?.closest('[role="list"], [data-testid*="list" i], main')
          || resolveRole('linear.workspace');
      }
      if (role === 'linear.issueDetail') {
        const description = document.querySelector('[aria-label="Issue description"]');
        return description?.closest('[role="dialog"], main, [data-testid*="issue" i]')
          || (location.pathname.includes('/issue/') ? resolveRole('linear.workspace') : null);
      }
      if (role === 'linear.statusControl') {
        return [...document.querySelectorAll('button, [role="button"]')]
          .find(element => visible(element) && /^(backlog|todo|in progress|started|done|completed)$/i.test(
            String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
          )) || null;
      }
      if (role === 'slack.workspace') {
        return document.querySelector('[data-qa="client_container"], .p-client, #client-ui')
          || document.body;
      }
      if (role === 'slack.composer') {
        return firstCandidate('[data-qa="texty_input"], [contenteditable="true"][role="textbox"]');
      }
      if (role === 'slack.sendButton') {
        const composer = resolveRole('slack.composer');
        return composer?.closest('form, [data-qa*="message_input" i]')
          ?.querySelector('[data-qa="texty_send_button"], button[aria-label*="send" i]')
          || firstCandidate('[data-qa="texty_send_button"], button[aria-label*="send" i]');
      }
      if (role === 'cursor.workbench') {
        return document.querySelector('.monaco-workbench') || document.body;
      }
      if (role === 'cursor.titlebar') {
        return firstCandidate('.monaco-workbench .part.titlebar, .part.titlebar');
      }
      if (role === 'youtube.player') {
        return firstCandidate('video.html5-main-video, #movie_player video, video');
      }
      return null;
    };
    const setElementRoles = (element, roles) => {
      if (!element) return;
      if (roles.size) element.setAttribute('data-attune-host-roles', [...roles].sort().join(' '));
      else element.removeAttribute('data-attune-host-roles');
    };
    const reconcile = () => {
      if (disposed) return;
      const previous = new Map(mappedElements);
      const rolesByElement = new Map();
      mappedElements.clear();
      for (const role of requestedRoles) {
        const element = resolveRole(role);
        if (!element) continue;
        mappedElements.set(role, element);
        const roles = rolesByElement.get(element) || new Set();
        roles.add(role);
        rolesByElement.set(element, roles);
      }
      for (const element of new Set(previous.values())) {
        if (!rolesByElement.has(element)) setElementRoles(element, new Set());
      }
      for (const [element, roles] of rolesByElement) setElementRoles(element, roles);
      const reports = Object.fromEntries(bindingSets.map(set => {
        const capabilities = Object.fromEntries(set.bindings.map(binding => {
          const element = mappedElements.get(binding.role);
          return [binding.name, {
            role: binding.role,
            required: binding.required,
            status: element ? 'available' : 'unavailable',
          }];
        }));
        const missingRequired = set.bindings
          .filter(binding => binding.required && !mappedElements.has(binding.role))
          .map(binding => binding.role);
        return [set.attunementId, {
          schemaVersion: set.schemaVersion,
          appName: set.appName,
          status: missingRequired.length
            ? 'unavailable'
            : Object.values(capabilities).some(capability => capability.status === 'unavailable')
              ? 'degraded'
              : 'compatible',
          missingRequired,
          capabilities,
          checkedAt: Date.now(),
        }];
      }));
      window.__attuneCompatibilityReports = reports;
      const changes = [...requestedRoles].filter(role => previous.get(role) !== mappedElements.get(role));
      if (changes.length) {
        for (const listener of listeners) {
          try { listener(changes); } catch (error) { console.warn('[attune] host mapping listener failed', error); }
        }
        window.dispatchEvent(new CustomEvent('attune:host-mappings-changed', { detail: { roles: changes } }));
      }
    };
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        reconcile();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    reconcile();
    window[mapperKey] = {
      resolve: role => mappedElements.get(role) || null,
      report: attunementId => window.__attuneCompatibilityReports?.[attunementId] || null,
      subscribe: listener => {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reconcile,
      cleanup: () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
        for (const element of new Set(mappedElements.values())) setElementRoles(element, new Set());
        mappedElements.clear();
        listeners.clear();
      },
    };
    window.__attuneHost = window[mapperKey];
  }
  if (!css) {
    current?.remove();
    status = 'removed';
  } else if (current?.dataset.attuneHash !== styleHash) {
    const style = current || document.createElement('style');
    style.id = id;
    style.dataset.attuneHash = styleHash;
    style.textContent = css;
    if (!current) document.head.append(style);
    status = 'applied';
  }
  if (scriptChanged) {
    try {
      window[cleanupKey]?.();
    } catch (error) {
      console.warn('[attune] workspace script cleanup failed', error);
    }
    window[cleanupKey] = undefined;
    window[scriptHashKey] = scriptHash;
  }
  if (script && scriptChanged) {
    window.__attuneRegisterCleanup = cleanup => {
      if (typeof cleanup !== 'function') return;
      const previousCleanup = window[cleanupKey];
      window[cleanupKey] = () => {
        try {
          previousCleanup?.();
        } finally {
          cleanup();
        }
      };
    };
    try {
      (0, eval)(script);
    } catch (error) {
      console.warn('[attune] workspace script failed', error);
    }
  }
  window[sourceHashKey] = sourceHash;
  window[styleHashKey] = styleHash;
  window[bindingsHashKey] = bindingsHash;
  window[bridgeHashKey] = bridgeHash;
  window[mapperVersionKey] = mapperVersion;
  return status;
})()`;
}

export function buildWorkspaceBridgeUpdateExpression(
  workspaceBridge: Record<string, unknown>,
): string {
  const safeWorkspaceBridge = JSON.stringify(workspaceBridge);
  const safeBridgeHash = JSON.stringify(hashValue(JSON.stringify(workspaceBridge)));
  const safeBridgeHashKey = JSON.stringify(WORKSPACE_BRIDGE_HASH_KEY);
  return `(() => {
  window.__attuneWorkspaceBridge = ${safeWorkspaceBridge};
  window[${safeBridgeHashKey}] = ${safeBridgeHash};
  return 'updated';
})()`;
}

export function buildRuntimeStateProbeExpression(): string {
  const safeId = JSON.stringify(STYLE_ELEMENT_ID);
  const safeSourceHashKey = JSON.stringify(WORKSPACE_SOURCE_HASH_KEY);
  const safeStyleHashKey = JSON.stringify(WORKSPACE_STYLE_HASH_KEY);
  const safeScriptHashKey = JSON.stringify(WORKSPACE_SCRIPT_HASH_KEY);
  const safeBindingsHashKey = JSON.stringify(WORKSPACE_BINDINGS_HASH_KEY);
  const safeBridgeHashKey = JSON.stringify(WORKSPACE_BRIDGE_HASH_KEY);
  const safeMapperVersionKey = JSON.stringify(HOST_MAPPER_VERSION_KEY);
  return `(() => ({
  sourceHash: window[${safeSourceHashKey}] || null,
  styleHash: window[${safeStyleHashKey}] || null,
  styleElementHash: document.getElementById(${safeId})?.dataset.attuneHash || null,
  scriptHash: window[${safeScriptHashKey}] || null,
  bindingsHash: window[${safeBindingsHashKey}] || null,
  bridgeHash: window[${safeBridgeHashKey}] || null,
  mapperVersion: window[${safeMapperVersionKey}] ?? null,
}))()`;
}

function getWorkspaceRuntimeState(
  source: string,
  workspaceBridge: Record<string, unknown>,
): RuntimeState {
  const workspaceSource = splitWorkspaceSource(source);
  return {
    sourceHash: hashValue(source),
    styleHash: hashValue(workspaceSource.css),
    styleElementHash: workspaceSource.css ? hashValue(workspaceSource.css) : null,
    scriptHash: hashValue(workspaceSource.script),
    bindingsHash: hashValue(JSON.stringify(workspaceSource.bindingSets)),
    bridgeHash: hashValue(JSON.stringify(workspaceBridge)),
    mapperVersion: HOST_MAPPER_VERSION,
  };
}

function runtimeStatesMatch(actual: RuntimeState | null, expected: RuntimeState): boolean {
  return Boolean(
    actual
    && actual.sourceHash === expected.sourceHash
    && actual.styleHash === expected.styleHash
    && actual.styleElementHash === expected.styleElementHash
    && actual.scriptHash === expected.scriptHash
    && actual.bindingsHash === expected.bindingsHash
    && actual.bridgeHash === expected.bridgeHash
    && actual.mapperVersion === expected.mapperVersion
  );
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function splitWorkspaceSource(source: string): {
  css: string;
  script: string;
  bindingSets: HostBindingSet[];
} {
  const scripts: string[] = [];
  const bindingSets: HostBindingSet[] = [];
  const withoutBindings = source.replace(WORKSPACE_BINDINGS_RE, (_match, metadata: string) => {
    try {
      const parsed = JSON.parse(metadata.trim()) as Partial<HostBindingSet>;
      if (
        typeof parsed.attunementId === 'string'
        && typeof parsed.appName === 'string'
        && Array.isArray(parsed.bindings)
      ) {
        bindingSets.push({
          schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
          attunementId: parsed.attunementId,
          appName: parsed.appName,
          bindings: parsed.bindings.filter((binding): binding is HostBinding => (
            Boolean(binding)
            && typeof binding.name === 'string'
            && typeof binding.role === 'string'
            && typeof binding.required === 'boolean'
          )),
        });
      }
    } catch {}
    return '';
  });
  const css = withoutBindings.replace(WORKSPACE_SCRIPT_RE, (_match, script: string) => {
    scripts.push(script.trim());
    return '';
  }).trim();

  return {
    css,
    script: scripts.join('\n;\n'),
    bindingSets,
  };
}

export function buildInspectionExpression(): string {
  return `(() => {
  const clean = (value, length = 140) =>
    String(value || '').replace(/\\s+/g, ' ').trim().slice(0, length);
  const quote = value => JSON.stringify(String(value));
  const visible = element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0
      && bounds.width > 0
      && bounds.height > 0
      && bounds.bottom >= 0
      && bounds.right >= 0
      && bounds.top <= innerHeight
      && bounds.left <= innerWidth;
  };
  const unique = selector => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const semanticSelector = element => {
    if (element.id) {
      const selector = '#' + CSS.escape(element.id);
      if (unique(selector)) return { selector, stability: 'high' };
    }
    for (const attribute of ['data-testid', 'data-test-id', 'data-qa', 'aria-label', 'name']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = '[' + attribute + '=' + quote(value) + ']';
      if (unique(selector)) return { selector, stability: 'high' };
    }
    const role = element.getAttribute('role');
    if (role) {
      const selector = '[role=' + quote(role) + ']';
      if (unique(selector)) return { selector, stability: 'medium' };
    }
    return null;
  };
  const structuralSelector = element => {
    const segments = [];
    let current = element;
    while (current && current !== document.documentElement && segments.length < 5) {
      const semantic = semanticSelector(current);
      if (semantic) {
        segments.unshift(semantic.selector);
        return { selector: segments.join(' > '), stability: segments.length === 1 ? semantic.stability : 'medium' };
      }
      let segment = current.tagName.toLowerCase();
      const classes = [...current.classList]
        .filter(name => name.length < 40 && !/[a-f0-9]{8,}/i.test(name))
        .slice(0, 2);
      if (classes.length) segment += '.' + classes.map(name => CSS.escape(name)).join('.');
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(sibling => sibling.tagName === current.tagName)
        : [];
      if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      segments.unshift(segment);
      const candidate = segments.join(' > ');
      if (unique(candidate)) return { selector: candidate, stability: classes.length ? 'medium' : 'low' };
      current = current.parentElement;
    }
    return { selector: segments.join(' > '), stability: 'low' };
  };
  const seen = new Set();
  const elements = [...document.querySelectorAll(
    'button, [role="button"], input, textarea, select, a, [aria-label], [data-testid], [data-test-id], [data-qa], h1, h2, h3, nav, aside, header, main'
  )]
    .filter(visible)
    .map(element => {
      const candidate = semanticSelector(element) || structuralSelector(element);
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector: candidate.selector,
        stability: candidate.stability,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        label: clean(element.getAttribute('aria-label')),
        text: clean(element.innerText || element.textContent),
        bounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        },
        styles: {
          display: style.display,
          position: style.position,
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontSize: style.fontSize,
        },
      };
    })
    .filter(item => item.selector && !seen.has(item.selector) && (seen.add(item.selector), true))
    .slice(0, 160);
  return {
    title: document.title,
    url: location.href,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
    },
    attuneStylePresent: Boolean(document.getElementById(${JSON.stringify(STYLE_ELEMENT_ID)})),
    elements,
  };
})()`;
}

async function getDebugTargets(port: number): Promise<DebugTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned ${response.status}`);
  }
  return response.json() as Promise<DebugTarget[]>;
}

async function sendDevToolsCommand<T>(
  webSocketUrl: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const socket = new WebSocket(webSocketUrl);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DevTools connection timed out')), 3000);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('DevTools connection failed'));
    }, { once: true });
  });

  try {
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: { message?: string } };
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(message.error.message || `DevTools rejected ${method}`));
          return;
        }
        resolve(message.result as T);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

function slugify(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'app';
}

function getSessionPath(appId: string): string {
  return join(SESSION_DIR, `${appId}.json`);
}

function readSession(sessionPath: string): SessionRecord | null {
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

function writeSession(sessionPath: string, session: SessionRecord): void {
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeAtomically(sessionPath, session);
}

function updateSession(sessionPath: string, update: Partial<SessionRecord>): void {
  const session = readSession(sessionPath);
  if (!session) return;
  writeSession(sessionPath, { ...session, ...update });
}

function writeAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2));
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Could not allocate a local debug port'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isProcessRunning(executablePath: string): boolean {
  try {
    execFileSync('pgrep', ['-f', executablePath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
