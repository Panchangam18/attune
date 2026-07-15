import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createServer } from 'net';
import { ensureConfig, readStylesheet } from './config.js';
import { type DiscoveredApp, getAppExecutablePath, getAppId } from './scan.js';

const ATTUNE_DIR = join(homedir(), '.attune');
const SESSION_DIR = join(ATTUNE_DIR, 'sessions');
const STYLE_ELEMENT_ID = 'attune-custom-stylesheet';
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

export function buildStyleInjectionExpression(css: string): string {
  const hash = createHash('sha256').update(css).digest('hex');
  const safeCss = JSON.stringify(css);
  const safeHash = JSON.stringify(hash);
  const safeId = JSON.stringify(STYLE_ELEMENT_ID);

  return `(() => {
  const id = ${safeId};
  const hash = ${safeHash};
  const css = ${safeCss};
  const current = document.getElementById(id);
  if (!css) {
    current?.remove();
    return 'removed';
  }
  if (current?.dataset.attuneHash === hash) return 'current';
  const style = current || document.createElement('style');
  style.id = id;
  style.dataset.attuneHash = hash;
  style.textContent = css;
  if (!current) document.head.append(style);
  return 'applied';
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
