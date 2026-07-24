import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
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
