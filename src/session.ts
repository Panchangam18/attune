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
const POLL_INTERVAL_MS = 500;
const MAX_MISSED_POLLS = 120;
const INSPECTION_TTL_MS = 24 * 60 * 60 * 1000;
const INSPECTION_TEMP_PREFIX = 'attune-inspect-';

interface DebugTarget {
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
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
    ATTUNE_REAL_CODEX_CLI_PATH: realCodexPath,
    CODEX_CLI_PATH: proxyPath,
  };
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
  const stopWorkspaceBridgeServer = startWorkspaceBridgeServer();

  const stop = () => {
    stopped = true;
    stopWorkspaceBridgeServer();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    try {
      const targets = await getDebugTargets(port);
      const stylesheet = readStylesheet(configPath);
      const pageTargets = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);

      const workspaceBridge = readWorkspaceBridgeStore();
      await Promise.all(pageTargets.map(target => injectStylesheet(target.webSocketDebuggerUrl!, stylesheet, workspaceBridge)));
      missedPolls = 0;
      updateSession(sessionPath, {
        status: 'attached',
        targetCount: pageTargets.length,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      missedPolls += 1;
      updateSession(sessionPath, {
        status: 'waiting',
        targetCount: 0,
        updatedAt: new Date().toISOString(),
      });
    }

    if (missedPolls >= MAX_MISSED_POLLS) {
      rmSync(sessionPath, { force: true });
      return;
    }

    await delay(POLL_INTERVAL_MS);
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
  const hash = createHash('sha256').update(css).digest('hex');
  const safeCss = JSON.stringify(workspaceSource.css);
  const safeHash = JSON.stringify(hash);
  const safeId = JSON.stringify(STYLE_ELEMENT_ID);
  const safeScript = JSON.stringify(workspaceSource.script);
  const safeWorkspaceBridge = JSON.stringify(workspaceBridge);

  return `(() => {
  const id = ${safeId};
  const hash = ${safeHash};
  const css = ${safeCss};
  const script = ${safeScript};
  window.__attuneWorkspaceBridge = ${safeWorkspaceBridge};
  const cleanupKey = '__attuneWorkspaceScriptCleanup';
  const scriptHashKey = '__attuneWorkspaceScriptHash';
  const current = document.getElementById(id);
  const sourceChanged = window[scriptHashKey] !== hash;
  let status = 'current';
  if (!css) {
    current?.remove();
    status = 'removed';
  } else if (current?.dataset.attuneHash !== hash) {
    const style = current || document.createElement('style');
    style.id = id;
    style.dataset.attuneHash = hash;
    style.textContent = css;
    if (!current) document.head.append(style);
    status = 'applied';
  }
  if (sourceChanged) {
    try {
      window[cleanupKey]?.();
    } catch (error) {
      console.warn('[attune] workspace script cleanup failed', error);
    }
    window[cleanupKey] = undefined;
    window[scriptHashKey] = hash;
  }
  if (script && sourceChanged) {
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
  return status;
})()`;
}

export function splitWorkspaceSource(source: string): { css: string; script: string } {
  const scripts: string[] = [];
  const css = source.replace(WORKSPACE_SCRIPT_RE, (_match, script: string) => {
    scripts.push(script.trim());
    return '';
  }).trim();

  return {
    css,
    script: scripts.join('\n;\n'),
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

async function injectStylesheet(
  webSocketUrl: string,
  css: string,
  workspaceBridge: Record<string, unknown>,
): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Style injection timed out')), 3000);
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
        if (message.id === 1) {
          if (message.error) {
            clearTimeout(timeout);
            reject(new Error('DevTools rejected CSP bypass'));
            return;
          }
          socket.send(JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: {
              expression: buildStyleInjectionExpression(css, workspaceBridge),
              returnByValue: true,
            },
          }));
          return;
        }
        if (message.id !== 2) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error('DevTools rejected style injection'));
          return;
        }
        resolve();
      });
      socket.send(JSON.stringify({
        id: 1,
        method: 'Page.setBypassCSP',
        params: {
          enabled: true,
        },
      }));
    });
  } finally {
    socket.close();
  }
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
