import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createServer } from 'net';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { ensureConfig, readStylesheet } from './config.js';
import { type DiscoveredApp, getAppExecutablePath, getAppId } from './scan.js';

const ATTUNE_DIR = join(homedir(), '.attune');
const SESSION_DIR = join(ATTUNE_DIR, 'sessions');
const WORKSPACE_BRIDGE_PATH = join(ATTUNE_DIR, 'workspace-bridge.json');
const WORKSPACE_BRIDGE_PORT = 47655;
const STYLE_ELEMENT_ID = 'attune-custom-stylesheet';
const WORKSPACE_SCRIPT_RE = /\/\*\s*@attune-script\s*\n([\s\S]*?)\n\s*@end-attune-script\s*\*\//g;
const POLL_INTERVAL_MS = 500;
const MAX_MISSED_POLLS = 120;

interface DebugTarget {
  type: string;
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

  const appProcess = spawn(executablePath, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=http://localhost',
  ], {
    cwd: dirname(executablePath),
    detached: true,
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

export async function runWatcher(configPath: string, port: number, sessionPath: string): Promise<void> {
  let stopped = false;
  let missedPolls = 0;
  startWorkspaceBridgeServer();

  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopped) {
    try {
      const targets = await getDebugTargets(port);
      const stylesheet = readStylesheet(configPath);
      const pageTargets = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl);

      await Promise.all(pageTargets.map(target => injectStylesheet(target.webSocketDebuggerUrl!, stylesheet)));
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

function startWorkspaceBridgeServer(): void {
  const server = createHttpServer((request, response) => {
    void handleWorkspaceBridgeRequest(request, response);
  });
  server.on('error', error => {
    if ('code' in error && error.code === 'EADDRINUSE') return;
    console.warn('[attune] workspace bridge unavailable', error);
  });
  server.listen(WORKSPACE_BRIDGE_PORT, '127.0.0.1');
}

async function handleWorkspaceBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    const payload = await readJsonBody(request);
    const store = readWorkspaceBridgeStore();
    store[key] = {
      updatedAt: new Date().toISOString(),
      payload,
    };
    writeWorkspaceBridgeStore(store);
    writeJson(response, 200, store[key]);
    return;
  }

  writeJson(response, 405, { error: 'Unsupported method.' });
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function buildStyleInjectionExpression(css: string): string {
  const workspaceSource = splitWorkspaceSource(css);
  const hash = createHash('sha256').update(css).digest('hex');
  const safeCss = JSON.stringify(workspaceSource.css);
  const safeHash = JSON.stringify(hash);
  const safeId = JSON.stringify(STYLE_ELEMENT_ID);
  const safeScript = JSON.stringify(workspaceSource.script);

  return `(() => {
  const id = ${safeId};
  const hash = ${safeHash};
  const css = ${safeCss};
  const script = ${safeScript};
  const current = document.getElementById(id);
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
  if (script) {
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

async function getDebugTargets(port: number): Promise<DebugTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned ${response.status}`);
  }
  return response.json() as Promise<DebugTarget[]>;
}

async function injectStylesheet(webSocketUrl: string, css: string): Promise<void> {
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
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error('DevTools rejected style injection'));
          return;
        }
        resolve();
      });
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: buildStyleInjectionExpression(css),
          returnByValue: true,
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
