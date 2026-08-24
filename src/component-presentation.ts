import { createHash, randomUUID } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const MAX_COMPONENT_VISUALIZATION_BYTES = 1_000_000;
// A conversation host may not mount the final inline visualization until well
// after the tool call that prepared it. Keep the private request discoverable
// long enough to survive response rendering, collapsing, and ordinary pauses.
export const COMPONENT_SMUGGLE_REQUEST_TTL_MS = 30 * 60 * 1000;
const COMPONENT_SMUGGLE_REQUEST_DIR = join(homedir(), '.attune', 'component-smuggle-requests');
const COMPONENT_SMUGGLE_BROKER_PATH = join(homedir(), '.attune', 'component-smuggle-broker.json');

export interface SemanticComponentCapture {
  appId: string;
  appName: string;
  role: string;
  description: string;
  capturedAt: string;
  width: number;
  height: number;
  imageMimeType: 'image/jpeg';
  imageBase64: string;
  resolution: {
    method: 'deterministic' | 'fingerprint' | 'unavailable';
    confidence: number;
    evidence: string[];
  };
}

export interface ComponentPresentationResult {
  appId: string;
  appName: string;
  role: string;
  description: string;
  capturedAt: string;
  visualizationPath: string;
  contentReference: string;
  bytes: number;
  static: true;
}

export interface ComponentSmuggleFingerprint {
  tag: string;
  domRole: string;
  label: string;
  text: string;
  attributes: Record<string, string>;
  classes: string[];
  ancestor: { tag: string; domRole: string; label: string } | null;
}

export interface PreparedComponentSmuggleSource {
  appId: string;
  appName: string;
  appPid?: number;
  transport?: 'cdp' | 'safari-apple-events';
  webSocketDebuggerUrl: string;
  safariPage?: {
    appPid: number;
    windowId: number;
    tabIndex: number;
    url: string;
  };
  anchor: {
    token: string;
    roles: string[];
    selector: string;
    fingerprint: ComponentSmuggleFingerprint;
    placement: 'inside';
  };
  description: string;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface LiveComponentSmuggleRequest {
  schemaVersion: 1;
  requestId: string;
  createdAt: string;
  expiresAt: string;
  source: Omit<PreparedComponentSmuggleSource, 'description' | 'bounds'>;
  target: {
    appId: 'com.openai.codex';
    appName: 'ChatGPT';
    slotId: string;
  };
}

export interface LiveComponentPresentationResult {
  appId: string;
  appName: string;
  role: string;
  description: string;
  visualizationPath: string;
  contentReference: string;
  requestId: string;
  bytes: number;
  live: true;
  static: false;
}

export interface LiveComponentPresentationStorage {
  brokerPath?: string;
  requestDirectory?: string;
}

export function buildComponentPresentationFragment(capture: SemanticComponentCapture): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(capture.imageBase64)) {
    throw new Error('Component capture did not contain valid base64 image data.');
  }
  const identity = `${capture.appId}:${capture.role}:${capture.capturedAt}`;
  const rootId = `attune-component-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
  const alt = escapeHtml(`${capture.appName}: ${capture.description}`);
  const width = Math.max(1, Math.round(capture.width));
  const height = Math.max(1, Math.round(capture.height));
  return `<div id="${rootId}" aria-label="${alt}">
  <style>
    #${rootId} { width: 100%; max-width: ${width}px; margin: 0 auto; line-height: 0; }
    #${rootId} img { display: block; width: 100%; height: auto; max-width: 100%; object-fit: contain; }
  </style>
  <img src="data:${capture.imageMimeType};base64,${capture.imageBase64}" alt="${alt}" width="${width}" height="${height}">
</div>`;
}

export function writeComponentPresentation(
  outputPath: string,
  capture: SemanticComponentCapture,
): ComponentPresentationResult {
  if (!outputPath.toLowerCase().endsWith('.html')) {
    throw new Error('Component presentation output must be an .html file.');
  }
  const fragment = buildComponentPresentationFragment(capture);
  const bytes = Buffer.byteLength(fragment);
  if (bytes >= MAX_COMPONENT_VISUALIZATION_BYTES) {
    throw new Error(`Component presentation is ${bytes} bytes; inline visualizations must be under ${MAX_COMPONENT_VISUALIZATION_BYTES} bytes.`);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, fragment);
  return {
    appId: capture.appId,
    appName: capture.appName,
    role: capture.role,
    description: capture.description,
    capturedAt: capture.capturedAt,
    visualizationPath: outputPath,
    contentReference: `visualize{"path":${JSON.stringify(outputPath)}}`,
    bytes,
    static: true,
  };
}

export function createLiveComponentPresentation(
  outputPath: string,
  source: PreparedComponentSmuggleSource,
  storage: LiveComponentPresentationStorage = {},
): LiveComponentPresentationResult {
  requireHtmlOutput(outputPath);
  assertLiveComponentBrokerAvailable(storage.brokerPath);
  const requestId = randomUUID();
  const slotId = `attune-live-${requestId}`;
  const fragment = buildLiveComponentSlotFragment({
    slotId,
    appName: source.appName,
    description: source.description,
    width: source.bounds.width,
    height: source.bounds.height,
  });
  const bytes = Buffer.byteLength(fragment);
  if (bytes >= MAX_COMPONENT_VISUALIZATION_BYTES) {
    throw new Error(`Live component slot is ${bytes} bytes; inline visualizations must be under ${MAX_COMPONENT_VISUALIZATION_BYTES} bytes.`);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, fragment);

  const createdAt = new Date();
  const request: LiveComponentSmuggleRequest = {
    schemaVersion: 1,
    requestId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + COMPONENT_SMUGGLE_REQUEST_TTL_MS).toISOString(),
    source: {
      appId: source.appId,
      appName: source.appName,
      ...(source.appPid ? { appPid: source.appPid } : {}),
      ...(source.transport ? { transport: source.transport } : {}),
      webSocketDebuggerUrl: source.webSocketDebuggerUrl,
      ...(source.safariPage ? { safariPage: source.safariPage } : {}),
      anchor: source.anchor,
    },
    target: { appId: 'com.openai.codex', appName: 'ChatGPT', slotId },
  };
  writeLiveComponentRequest(request, storage.requestDirectory);
  return {
    appId: source.appId,
    appName: source.appName,
    role: source.anchor.roles[0] || '',
    description: source.description,
    visualizationPath: outputPath,
    contentReference: visualizationContentReference(outputPath),
    requestId,
    bytes,
    live: true,
    static: false,
  };
}

export function buildLiveComponentSlotFragment(input: {
  slotId: string;
  appName: string;
  description: string;
  width: number;
  height: number;
}): string {
  const safeSlotId = escapeHtml(input.slotId);
  const rootId = `attune-live-component-${createHash('sha256').update(input.slotId).digest('hex').slice(0, 12)}`;
  const label = escapeHtml(`${input.appName}: ${input.description}`);
  const width = Math.max(1, Math.round(input.width));
  const height = Math.max(1, Math.min(680, Math.round(input.height)));
  return `<div id="${rootId}" data-attune-smuggle-slot="${safeSlotId}" aria-label="${label}">
  <style>
    #${rootId} { width: 100%; max-width: ${width}px; min-height: ${height}px; margin: 0 auto; position: relative; }
    #${rootId}:has(> attune-component-smuggle) { min-height: 0; }
    #${rootId}:has(> attune-component-smuggle) > [data-attune-smuggle-placeholder] { display: none; }
    #${rootId} > [data-attune-smuggle-placeholder] { color: var(--muted-foreground); padding: 12px 0; }
  </style>
  <div data-attune-smuggle-placeholder role="status">Connecting to ${escapeHtml(input.appName)}…</div>
</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function requireHtmlOutput(outputPath: string): void {
  if (!outputPath.toLowerCase().endsWith('.html')) {
    throw new Error('Component presentation output must be an .html file.');
  }
}

function visualizationContentReference(outputPath: string): string {
  return `visualize{"path":${JSON.stringify(outputPath)}}`;
}

export function assertLiveComponentBrokerAvailable(brokerPath = COMPONENT_SMUGGLE_BROKER_PATH): void {
  try {
    const broker = JSON.parse(readFileSync(brokerPath, 'utf8')) as {
      schemaVersion?: unknown;
      updatedAt?: unknown;
    };
    const age = Date.now() - Date.parse(String(broker.updatedAt || ''));
    if (broker.schemaVersion !== 1 || !Number.isFinite(age) || age < 0 || age > 5_000) throw new Error();
  } catch {
    throw new Error('Attune App live component broker is unavailable. Open the updated Attune App, or omit --live for a static capture.');
  }
}

function writeLiveComponentRequest(
  request: LiveComponentSmuggleRequest,
  requestDirectory = COMPONENT_SMUGGLE_REQUEST_DIR,
): void {
  mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
  chmodSync(requestDirectory, 0o700);
  const requestPath = join(requestDirectory, `${request.requestId}.json`);
  const temporaryPath = `${requestPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(request, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, requestPath);
    chmodSync(requestPath, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
