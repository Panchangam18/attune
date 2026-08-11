import { execFile } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import {
  createRoutingDiagnosticId,
  createRoutingDiagnostics,
  routingErrorCode,
  type RoutingDiagnostics,
} from './claude-gpt-diagnostics.js';
import { CLAUDE_GPT_MODEL_ALIASES } from './claude-gpt-tls-router.js';

const execFileAsync = promisify(execFile);

const TARGET_HOST = 'claude.ai';
const TARGET_AUTHORITY = `${TARGET_HOST}:443`;
const ANTHROPIC_API_AUTHORITY = 'api.anthropic.com:443';
const DEFAULT_TARGET_UPSTREAM = `https://${TARGET_HOST}`;
const DEFAULT_MAX_BOOTSTRAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SELECTION_BYTES = 4 * 1024;
const READINESS_PROTOCOL_VERSION = 1;
const READINESS_PATH = '/.attune/claude-web-bootstrap-proxy/ready';
const PAC_PATH = '/proxy.pac';
const READY_FILE = 'ready.json';
const SELECTIONS_FILE = 'selections.json';
const CERTIFICATE_KEY_FILE = 'claude.ai-key.pem';
const CERTIFICATE_FILE = 'claude.ai.pem';
const CERTIFICATE_CONFIG_FILE = 'claude.ai.cnf';
const UUID_PATTERN = '[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);
const ORG_BOOTSTRAP_RE = new RegExp(
  `^/(?:api|edge-api)/bootstrap/(${UUID_PATTERN})/app_start$`,
);
const CODE_SELECTION_RE = new RegExp(
  `^/(?:api|edge-api)/organizations/(${UUID_PATTERN})/model_selector_state/code$`,
);
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const CLAUDE_GPT_MODEL_CATALOG = Object.freeze([
  Object.freeze({ id: CLAUDE_GPT_MODEL_ALIASES[0], name: 'GPT-5.6 Sol' }),
  Object.freeze({ id: CLAUDE_GPT_MODEL_ALIASES[1], name: 'GPT-5.6 Terra' }),
  Object.freeze({ id: CLAUDE_GPT_MODEL_ALIASES[2], name: 'GPT-5.6 Luna' }),
] as const);

const ALIAS_BY_ID: ReadonlyMap<string, (typeof CLAUDE_GPT_MODEL_CATALOG)[number]> = new Map(
  CLAUDE_GPT_MODEL_CATALOG.map(model => [model.id, model]),
);

export interface ClaudeWebBootstrapProxyLaunchConfiguration {
  proxyPacUrl: string;
  spkiHash: string;
}

export interface ClaudeWebBootstrapProxyStatus extends ClaudeWebBootstrapProxyLaunchConfiguration {
  running: boolean;
  port: number;
}

export interface ClaudeWebBootstrapProxyHandle {
  readonly launchConfiguration: Readonly<ClaudeWebBootstrapProxyLaunchConfiguration>;
  readonly port: number;
  readonly spkiHash: string;
  status(): ClaudeWebBootstrapProxyStatus;
  health(): Promise<boolean>;
  cleanup(): Promise<void>;
}

export interface ClaudeWebBootstrapProxyOptions {
  /** Defaults to ~/.attune/claude-web-bootstrap-proxy. */
  stateDirectory?: string;
  /** Per-launch nonce shared only between the launcher and its watcher. */
  readinessToken?: string;
  /** Defaults to /usr/bin/openssl. */
  opensslPath?: string;
  /** Defaults to https://claude.ai. Test HTTP origins must be loopback. */
  targetUpstream?: string | URL;
  /** Test-only permission for a loopback HTTP target upstream. */
  allowInsecureTargetUpstream?: boolean;
  /** Defaults to an ephemeral private loopback port. */
  proxyPort?: number;
  /** Claude API router UDS used only for authenticated api.anthropic.com CONNECTs. */
  anthropicSocketPath?: string;
  /** Per-launch token required for Claude Code and arbitrary CONNECT tunnels. */
  proxyAccessToken?: string;
  /** Defaults to 8 MiB. */
  maxBootstrapBytes?: number;
  /** Defaults to 4 KiB. */
  maxSelectionBytes?: number;
  /** Optional privacy-safe JSONL event log. Disabled unless explicitly set. */
  diagnosticsPath?: string;
}

interface NormalizedOptions {
  stateDirectory: string;
  readinessPath: string;
  selectionsPath: string;
  certificateKeyPath: string;
  certificatePath: string;
  readinessToken: string;
  opensslPath: string;
  targetUpstream: URL;
  proxyPort: number;
  anthropicSocketPath: string | null;
  proxyAuthorization: string | null;
  maxBootstrapBytes: number;
  maxSelectionBytes: number;
  diagnostics: RoutingDiagnostics;
}

interface CertificateMaterial {
  key: Buffer;
  certificate: Buffer;
  spkiHash: string;
}

interface ReadyRecord extends ClaudeWebBootstrapProxyLaunchConfiguration {
  schemaVersion: number;
  readinessToken: string;
  port: number;
  pid: number;
}

interface SelectionRecord {
  schemaVersion: 1;
  selections: Record<string, string>;
}

interface BootstrapAnalysis {
  payload: Record<string, unknown>;
  selectorConfig: unknown[];
  codeSurface: Record<string, unknown>;
  nativeModels: Array<Record<string, unknown>>;
  selectorState: unknown;
  codeState: Record<string, unknown> | null;
  accountUuid: string | null;
  orgUuid: string | null;
  nativeModelIds: string[];
  aliasesAllowed: boolean;
}

interface OrganizationContext {
  accountUuid: string;
  orgUuid: string;
  aliasesAllowed: boolean;
  nativeModelIds: ReadonlySet<string>;
}

interface RuntimePolicyState {
  activeAccountUuid: string | null;
  activeAccountGeneration: number;
  nextBootstrapGeneration: number;
  latestGenericGeneration: number;
  organizationGenerations: Map<string, number>;
  organizationContexts: Map<string, OrganizationContext>;
}

interface SelectionBody {
  model: string;
  thinking?: unknown;
}

const activeProxies = new Map<string, Promise<ClaudeWebBootstrapProxyHandle>>();
const activeProxyTokens = new Map<string, string>();
const certificateJobs = new Map<string, Promise<CertificateMaterial>>();

export function createClaudeWebBootstrapProxyReadinessToken(): string {
  return randomBytes(24).toString('base64url');
}

function normalizeOptions(options: ClaudeWebBootstrapProxyOptions): NormalizedOptions {
  const stateDirectory = resolve(
    options.stateDirectory ?? join(homedir(), '.attune', 'claude-web-bootstrap-proxy'),
  );
  const readinessToken = options.readinessToken ?? '';
  if (readinessToken && !/^[A-Za-z0-9_-]{16,128}$/.test(readinessToken)) {
    throw new Error('The Claude web bootstrap proxy readiness token is invalid.');
  }
  const targetUpstream = new URL(options.targetUpstream ?? DEFAULT_TARGET_UPSTREAM);
  if (targetUpstream.username || targetUpstream.password || targetUpstream.hash) {
    throw new Error('The Claude web bootstrap target upstream cannot contain credentials or fragments.');
  }
  const isProductionUpstream = targetUpstream.protocol === 'https:'
    && targetUpstream.hostname === TARGET_HOST
    && !targetUpstream.port
    && targetUpstream.pathname === '/'
    && !targetUpstream.search;
  const isTestUpstream = options.allowInsecureTargetUpstream === true
    && isLoopbackHostname(targetUpstream.hostname)
    && (targetUpstream.protocol === 'http:' || targetUpstream.protocol === 'https:')
    && targetUpstream.pathname === '/'
    && !targetUpstream.search;
  if (!isProductionUpstream && !isTestUpstream) {
    throw new Error('The Claude web bootstrap target upstream must be exact or an explicit loopback test origin.');
  }
  const proxyPort = options.proxyPort ?? 0;
  if (!Number.isInteger(proxyPort) || proxyPort < 0 || proxyPort > 65535) {
    throw new Error('The Claude web bootstrap proxy port is invalid.');
  }
  const anthropicSocketPath = options.anthropicSocketPath
    ? resolve(options.anthropicSocketPath)
    : null;
  const proxyAccessToken = options.proxyAccessToken ?? null;
  if ((anthropicSocketPath === null) !== (proxyAccessToken === null)) {
    throw new Error('Claude API proxy routing requires both a socket path and access token.');
  }
  if (proxyAccessToken !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(proxyAccessToken)) {
    throw new Error('The Claude API proxy access token is invalid.');
  }
  const maxBootstrapBytes = options.maxBootstrapBytes ?? DEFAULT_MAX_BOOTSTRAP_BYTES;
  const maxSelectionBytes = options.maxSelectionBytes ?? DEFAULT_MAX_SELECTION_BYTES;
  if (!Number.isSafeInteger(maxBootstrapBytes) || maxBootstrapBytes <= 0) {
    throw new Error('maxBootstrapBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxSelectionBytes) || maxSelectionBytes <= 0) {
    throw new Error('maxSelectionBytes must be a positive safe integer.');
  }
  return {
    stateDirectory,
    readinessPath: join(stateDirectory, READY_FILE),
    selectionsPath: join(stateDirectory, SELECTIONS_FILE),
    certificateKeyPath: join(stateDirectory, CERTIFICATE_KEY_FILE),
    certificatePath: join(stateDirectory, CERTIFICATE_FILE),
    readinessToken,
    opensslPath: options.opensslPath ?? '/usr/bin/openssl',
    targetUpstream,
    proxyPort,
    anthropicSocketPath,
    proxyAuthorization: proxyAccessToken === null
      ? null
      : `Basic ${Buffer.from(`attune:${proxyAccessToken}`).toString('base64')}`,
    maxBootstrapBytes,
    maxSelectionBytes,
    diagnostics: createRoutingDiagnostics(options.diagnosticsPath),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 160
    && SAFE_MODEL_ID_RE.test(value);
}

function parseBootstrapPath(rawPath: string | undefined): { pathOrgUuid: string | null } | null {
  if (!rawPath) return null;
  let url: URL;
  try {
    url = new URL(rawPath, `https://${TARGET_HOST}`);
  } catch {
    return null;
  }
  if (url.origin !== `https://${TARGET_HOST}` || url.hash) return null;
  if (url.pathname === '/api/bootstrap' || url.pathname === '/edge-api/bootstrap') {
    return url.search ? null : { pathOrgUuid: null };
  }
  const match = ORG_BOOTSTRAP_RE.exec(url.pathname);
  if (!match) return null;
  const queryEntries = [...url.searchParams.entries()];
  if (queryEntries.length > 0) {
    const query = new Map(queryEntries);
    const allowedQuery = new Map([
      ['statsig_hashing_algorithm', 'djb2'],
      ['growthbook_format', 'sdk'],
      ['include_system_prompts', 'false'],
    ]);
    if (
      query.size !== queryEntries.length
      || [...query].some(([key, value]) => allowedQuery.get(key) !== value)
    ) return null;
  }
  return { pathOrgUuid: match[1].toLowerCase() };
}

function parseSelectionPath(rawPath: string | undefined): string | null {
  if (!rawPath) return null;
  let url: URL;
  try {
    url = new URL(rawPath, `https://${TARGET_HOST}`);
  } catch {
    return null;
  }
  if (url.origin !== `https://${TARGET_HOST}` || url.search || url.hash) return null;
  return CODE_SELECTION_RE.exec(url.pathname)?.[1]?.toLowerCase() ?? null;
}

function analyzeBootstrap(payload: unknown, pathOrgUuid: string | null): BootstrapAnalysis | null {
  if (!isRecord(payload)) return null;
  const selectorConfig = payload.model_selector_config;
  if (!Array.isArray(selectorConfig) || selectorConfig.length === 0 || selectorConfig.length > 32) {
    return null;
  }
  const codeSurfaces = selectorConfig.filter(
    (surface): surface is Record<string, unknown> => isRecord(surface) && surface.id === 'code',
  );
  if (codeSurfaces.length !== 1) return null;
  const codeSurface = codeSurfaces[0];
  const models = codeSurface.models;
  if (!Array.isArray(models) || models.length === 0 || models.length > 64) return null;
  if (!models.every(model => isRecord(model)
    && isSafeModelId(model.id)
    && typeof model.name === 'string'
    && model.name.length > 0
    && model.name.length <= 160)) return null;

  const typedModels = models as Array<Record<string, unknown>>;
  const existingAliases = typedModels.filter(model => ALIAS_BY_ID.has(model.id as string));
  if (existingAliases.some(model => ALIAS_BY_ID.get(model.id as string)?.name !== model.name)) {
    return null;
  }
  const nativeModels = typedModels.filter(model => !ALIAS_BY_ID.has(model.id as string));
  const nativeModelIds = nativeModels.map(model => model.id as string);
  if (
    nativeModels.length === 0
    || nativeModels.length > 61
    || new Set(nativeModelIds).size !== nativeModelIds.length
  ) return null;

  const selectorState = payload.model_selector_state;
  const codeStates = Array.isArray(selectorState) && selectorState.length <= 32
    ? selectorState.filter(
      (entry): entry is Record<string, unknown> => isRecord(entry) && entry.id === 'code',
    )
    : [];
  if (codeStates.length !== 1) return null;
  const codeState = codeStates[0];
  if (!isSafeModelId(codeState.model) || !nativeModelIds.includes(codeState.model)) return null;
  const enforcedModel = codeState.org_enforced_default_model;
  if (
    enforcedModel !== null
    && enforcedModel !== undefined
    && (!isSafeModelId(enforcedModel) || !nativeModelIds.includes(enforcedModel))
  ) return null;
  const aliasesAllowed = (codeState?.org_enforced_default_model ?? null) === null;
  const resolvedOrgUuid = isUuid(payload.resolved_org_uuid)
    ? payload.resolved_org_uuid.toLowerCase()
    : null;
  if (pathOrgUuid && resolvedOrgUuid && pathOrgUuid !== resolvedOrgUuid) return null;
  const orgUuid = pathOrgUuid ?? resolvedOrgUuid;
  const accountUuid = isRecord(payload.account) && isUuid(payload.account.uuid)
    ? payload.account.uuid.toLowerCase()
    : null;
  if (!orgUuid || !accountUuid) return null;
  return {
    payload,
    selectorConfig,
    codeSurface,
    nativeModels,
    selectorState,
    codeState,
    accountUuid,
    orgUuid,
    nativeModelIds,
    aliasesAllowed,
  };
}

function augmentBootstrap(analysis: BootstrapAnalysis, selectedAlias: string | null): unknown {
  const aliasModels = analysis.aliasesAllowed
    ? CLAUDE_GPT_MODEL_CATALOG.map(alias => ({
      id: alias.id,
      name: alias.name,
      description: 'OpenAI model routed locally by Attune.',
      recommended: false,
    }))
    : [];
  const nextCodeSurface = {
    ...analysis.codeSurface,
    models: [...analysis.nativeModels, ...aliasModels],
  };
  const nextSelectorConfig = analysis.selectorConfig.map(surface => (
    surface === analysis.codeSurface ? nextCodeSurface : surface
  ));
  let nextSelectorState = analysis.selectorState;
  if (
    selectedAlias
    && analysis.aliasesAllowed
    && ALIAS_BY_ID.has(selectedAlias)
    && analysis.codeState
    && Array.isArray(nextSelectorState)
    && nextSelectorState.length <= 32
  ) {
    nextSelectorState = nextSelectorState.map(entry => (
      entry === analysis.codeState
        ? {
          ...entry,
          model: selectedAlias,
          source: 'user_setting',
          preset_key: null,
          thinking: null,
        }
        : entry
    ));
  }
  return {
    ...analysis.payload,
    model_selector_config: nextSelectorConfig,
    ...(nextSelectorState !== analysis.selectorState
      ? { model_selector_state: nextSelectorState }
      : {}),
  };
}

function parseSelectionBody(body: Buffer, maxBytes: number): SelectionBody | null {
  if (body.length === 0 || body.length > maxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  if (!keys.includes('model') || keys.some(key => key !== 'model' && key !== 'thinking')) return null;
  if ('thinking' in parsed && !isValidThinkingSelection(parsed.thinking)) return null;
  return isSafeModelId(parsed.model)
    ? { model: parsed.model, ...('thinking' in parsed ? { thinking: parsed.thinking } : {}) }
    : null;
}

function isValidThinkingSelection(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'type' && key !== 'effort' && key !== 'mode')) return false;
  const type = value.type;
  if (typeof type !== 'string' || !['effort', 'mode', 'effort_and_mode', 'none'].includes(type)) {
    return false;
  }
  const hasEffort = value.effort !== undefined && value.effort !== null;
  const hasMode = value.mode !== undefined && value.mode !== null;
  if (hasEffort && (typeof value.effort !== 'string' || value.effort.length > 160)) return false;
  if (hasMode && (typeof value.mode !== 'string' || value.mode.length > 160)) return false;
  if (type === 'effort') return hasEffort && !hasMode;
  if (type === 'mode') return hasMode && !hasEffort;
  if (type === 'effort_and_mode') return hasEffort && hasMode;
  return type === 'none' && !hasEffort && !hasMode;
}

class SelectionStore {
  private record: SelectionRecord = { schemaVersion: 1, selections: {} };
  private mutation = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink()) return;
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.selections)) return;
      const selections: Record<string, string> = {};
      for (const [key, alias] of Object.entries(parsed.selections).slice(0, 512)) {
        if (/^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(key) && ALIAS_BY_ID.has(alias as string)) {
          selections[key] = alias as string;
        }
      }
      this.record = { schemaVersion: 1, selections };
      await chmod(this.path, 0o600);
    } catch {
      // Missing or malformed state is equivalent to no local selection.
    }
  }

  get(accountUuid: string, orgUuid: string): string | null {
    const alias = this.record.selections[`${accountUuid}:${orgUuid}`];
    return ALIAS_BY_ID.has(alias) ? alias : null;
  }

  set(accountUuid: string, orgUuid: string, alias: string): Promise<void> {
    return this.mutate(record => {
      record.selections[`${accountUuid}:${orgUuid}`] = alias;
    });
  }

  clear(accountUuid: string, orgUuid: string): Promise<void> {
    return this.mutate(record => {
      delete record.selections[`${accountUuid}:${orgUuid}`];
    });
  }

  private mutate(change: (record: SelectionRecord) => void): Promise<void> {
    const operation = this.mutation.then(async () => {
      const next: SelectionRecord = {
        schemaVersion: 1,
        selections: { ...this.record.selections },
      };
      change(next);
      await writePrivateJson(this.path, next);
      this.record = next;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }
}

export function ensureClaudeWebBootstrapProxy(
  options: ClaudeWebBootstrapProxyOptions = {},
): Promise<ClaudeWebBootstrapProxyHandle> {
  const normalized = normalizeOptions(options);
  const existing = activeProxies.get(normalized.stateDirectory);
  if (existing) {
    if (activeProxyTokens.get(normalized.stateDirectory) !== normalized.readinessToken) {
      throw new Error('This process already owns the Claude web bootstrap proxy for another launch.');
    }
    return existing;
  }

  let startPromise: Promise<ClaudeWebBootstrapProxyHandle>;
  startPromise = startProxy(normalized, () => {
    if (activeProxies.get(normalized.stateDirectory) === startPromise) {
      activeProxies.delete(normalized.stateDirectory);
      activeProxyTokens.delete(normalized.stateDirectory);
    }
  }).catch((error: unknown) => {
    if (activeProxies.get(normalized.stateDirectory) === startPromise) {
      activeProxies.delete(normalized.stateDirectory);
      activeProxyTokens.delete(normalized.stateDirectory);
    }
    throw error;
  });
  activeProxies.set(normalized.stateDirectory, startPromise);
  activeProxyTokens.set(normalized.stateDirectory, normalized.readinessToken);
  return startPromise;
}

export async function waitForClaudeWebBootstrapProxy(
  options: ClaudeWebBootstrapProxyOptions = {},
  timeoutMs = 10_000,
): Promise<Readonly<ClaudeWebBootstrapProxyLaunchConfiguration>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('The Claude web bootstrap proxy readiness timeout must be between 1 and 60000 ms.');
  }
  const normalized = normalizeOptions(options);
  if (!normalized.readinessToken) {
    throw new Error('The Claude web bootstrap proxy readiness token is required.');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await readReadyRecord(normalized.readinessPath);
    if (
      record
      && record.readinessToken === normalized.readinessToken
      && await probeReadiness(record, normalized.readinessToken, Math.min(500, deadline - Date.now()))
    ) {
      return Object.freeze({ proxyPacUrl: record.proxyPacUrl, spkiHash: record.spkiHash });
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error('The Claude web bootstrap proxy did not become ready before launch.');
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  if (path === resolve('/') || path === resolve(homedir())) {
    throw new Error('The Claude web bootstrap proxy state directory is too broad.');
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The Claude web bootstrap proxy state path must be a private directory.');
  }
  await chmod(path, 0o700);
}

async function ensureCertificateMaterial(options: NormalizedOptions): Promise<CertificateMaterial> {
  const existing = certificateJobs.get(options.stateDirectory);
  if (existing) return existing;
  let job: Promise<CertificateMaterial>;
  job = loadOrGenerateCertificateMaterial(options).finally(() => {
    if (certificateJobs.get(options.stateDirectory) === job) certificateJobs.delete(options.stateDirectory);
  });
  certificateJobs.set(options.stateDirectory, job);
  return job;
}

async function loadOrGenerateCertificateMaterial(
  options: NormalizedOptions,
): Promise<CertificateMaterial> {
  try {
    const material = await loadCertificateMaterial(options.certificateKeyPath, options.certificatePath);
    await Promise.all([
      chmod(options.certificateKeyPath, 0o600),
      chmod(options.certificatePath, 0o600),
    ]);
    return material;
  } catch {
    // A valid existing private key is retained during certificate renewal so
    // the Chromium SPKI exception stays stable across Attune/App updates.
  }

  let reusableKey = false;
  try {
    const keyInfo = await lstat(options.certificateKeyPath);
    if (!keyInfo.isFile() || keyInfo.isSymbolicLink()) throw new Error('invalid key path');
    createPrivateKey(await readFile(options.certificateKeyPath));
    reusableKey = true;
    await chmod(options.certificateKeyPath, 0o600);
  } catch {
    reusableKey = false;
  }
  await generateCertificateMaterial(options, reusableKey);
  const material = await loadCertificateMaterial(options.certificateKeyPath, options.certificatePath);
  await Promise.all([
    chmod(options.certificateKeyPath, 0o600),
    chmod(options.certificatePath, 0o600),
  ]);
  return material;
}

async function loadCertificateMaterial(keyPath: string, certificatePath: string): Promise<CertificateMaterial> {
  const [keyInfo, certificateInfo] = await Promise.all([lstat(keyPath), lstat(certificatePath)]);
  if (
    !keyInfo.isFile()
    || keyInfo.isSymbolicLink()
    || !certificateInfo.isFile()
    || certificateInfo.isSymbolicLink()
  ) throw new Error('The Claude web bootstrap certificate paths must be regular files.');
  const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  createSecureContext({ key, cert: certificate });
  const parsed = new X509Certificate(certificate);
  const now = Date.now();
  const validFrom = Date.parse(parsed.validFrom);
  const validUntil = Date.parse(parsed.validTo);
  if (
    !parsed.checkHost(TARGET_HOST)
    || !parsed.checkPrivateKey(createPrivateKey(key))
    || !Number.isFinite(validFrom)
    || !Number.isFinite(validUntil)
    || validFrom > now
    || validUntil < now + 7 * 24 * 60 * 60 * 1000
  ) throw new Error('The Claude web bootstrap certificate is invalid or near expiry.');
  const spki = parsed.publicKey.export({ type: 'spki', format: 'der' });
  return {
    key,
    certificate,
    spkiHash: createHash('sha256').update(spki).digest('base64'),
  };
}

async function generateCertificateMaterial(
  options: NormalizedOptions,
  reuseExistingKey: boolean,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(options.stateDirectory, '.certificate-'));
  await chmod(temporaryDirectory, 0o700);
  const temporaryKey = join(temporaryDirectory, CERTIFICATE_KEY_FILE);
  const temporaryCertificate = join(temporaryDirectory, CERTIFICATE_FILE);
  const configuration = join(temporaryDirectory, CERTIFICATE_CONFIG_FILE);
  try {
    const keyPath = reuseExistingKey ? options.certificateKeyPath : temporaryKey;
    if (!reuseExistingKey) {
      await runOpenSsl(options.opensslPath, [
        'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', temporaryKey,
      ]);
      await chmod(temporaryKey, 0o600);
    }
    await writeFile(configuration, [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=server',
      'prompt=no',
      '[dn]',
      `CN=${TARGET_HOST}`,
      '[server]',
      `subjectAltName=DNS:${TARGET_HOST}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'), { mode: 0o600 });
    await runOpenSsl(options.opensslPath, [
      'req', '-x509', '-new', '-sha256', '-days', '365',
      '-key', keyPath,
      '-out', temporaryCertificate,
      '-config', configuration,
    ]);
    await chmod(temporaryCertificate, 0o600);
    await loadCertificateMaterial(keyPath, temporaryCertificate);
    if (!reuseExistingKey) await rename(temporaryKey, options.certificateKeyPath);
    await rename(temporaryCertificate, options.certificatePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function runOpenSsl(executable: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
  } catch {
    throw new Error('Attune could not generate the private Claude web bootstrap certificate.');
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readReadyRecord(path: string): Promise<ReadyRecord | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(parsed)
      || parsed.schemaVersion !== READINESS_PROTOCOL_VERSION
      || typeof parsed.readinessToken !== 'string'
      || !Number.isInteger(parsed.port)
      || (parsed.port as number) <= 0
      || (parsed.port as number) > 65535
      || !Number.isInteger(parsed.pid)
      || typeof parsed.proxyPacUrl !== 'string'
      || parsed.proxyPacUrl !== `http://127.0.0.1:${parsed.port}${PAC_PATH}`
      || typeof parsed.spkiHash !== 'string'
      || !/^[A-Za-z0-9+/]{43}=$/.test(parsed.spkiHash)) return null;
    return parsed as unknown as ReadyRecord;
  } catch {
    return null;
  }
}

function probeReadiness(record: ReadyRecord, readinessToken: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveProbe => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: record.port,
      path: READINESS_PATH,
      method: 'GET',
      headers: { 'x-attune-readiness-token': readinessToken },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    }, response => {
      response.resume();
      response.once('end', () => resolveProbe(response.statusCode === 204));
    });
    request.once('error', () => resolveProbe(false));
    request.end();
  });
}

async function removeReadyIfOwned(path: string, readinessToken: string): Promise<void> {
  const record = await readReadyRecord(path);
  if (record?.readinessToken === readinessToken && record.pid === process.pid) {
    await rm(path, { force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function startProxy(
  options: NormalizedOptions,
  onClosed: () => void,
): Promise<ClaudeWebBootstrapProxyHandle> {
  await ensurePrivateDirectory(options.stateDirectory);
  const certificate = await ensureCertificateMaterial(options);
  const selections = new SelectionStore(options.selectionsPath);
  await selections.load();
  const policyState: RuntimePolicyState = {
    activeAccountUuid: null,
    activeAccountGeneration: 0,
    nextBootstrapGeneration: 0,
    latestGenericGeneration: 0,
    organizationGenerations: new Map(),
    organizationContexts: new Map(),
  };
  const sockets = new Set<Socket>();

  const targetServer = createHttpsServer({
    key: certificate.key,
    cert: certificate.certificate,
    ALPNProtocols: ['http/1.1'],
  }, (request, response) => {
    void handleTargetRequest(request, response, options, selections, policyState)
      .catch(() => failResponse(response));
  });
  targetServer.on('upgrade', (request, socket, head) => {
    handleTargetUpgrade(request, socket as Socket, head, options, sockets);
  });
  targetServer.on('tlsClientError', () => {
    // TLS failures are deliberately silent because adjacent metadata can be sensitive.
  });
  targetServer.on('error', () => {
    // Health/status expose failure without printing request-adjacent details.
  });
  trackServerSockets(targetServer, sockets);

  let proxyServer: HttpServer | null = null;
  let running = true;
  let closed = false;
  let cleanupPromise: Promise<void> | null = null;
  const markClosed = () => {
    running = false;
    if (closed) return;
    closed = true;
    options.diagnostics.write('proxy', 'stopped');
    onClosed();
  };

  try {
    const targetPort = await listenLoopback(targetServer, 0);
    proxyServer = createHttpServer((request, response) => {
      handleControlRequest(request, response, options.readinessToken, proxyServerPort(proxyServer!));
    });
    proxyServer.on('connect', (request, socket, head) => {
      handleConnect(request, socket as Socket, head, targetPort, options, sockets);
    });
    proxyServer.on('clientError', (_error, socket) => socket.destroy());
    proxyServer.on('error', () => {
      // Reflected by status/health; never log proxy-adjacent metadata.
    });
    trackServerSockets(proxyServer, sockets);
    const port = await listenLoopback(proxyServer, options.proxyPort);
    options.diagnostics.write('proxy', 'started', {
      proxyPort: port,
      apiRouterEnabled: options.anthropicSocketPath !== null,
    });
    const launchConfiguration = Object.freeze({
      proxyPacUrl: `http://127.0.0.1:${port}${PAC_PATH}`,
      spkiHash: certificate.spkiHash,
    });
    const readyRecord: ReadyRecord = {
      schemaVersion: READINESS_PROTOCOL_VERSION,
      readinessToken: options.readinessToken,
      port,
      pid: process.pid,
      ...launchConfiguration,
    };
    await writePrivateJson(options.readinessPath, readyRecord);
    proxyServer.unref();
    targetServer.unref();
    proxyServer.once('close', markClosed);
    targetServer.once('close', markClosed);

    const handle: ClaudeWebBootstrapProxyHandle = {
      launchConfiguration,
      port,
      spkiHash: certificate.spkiHash,
      status: () => ({
        running: running && Boolean(proxyServer?.listening) && targetServer.listening,
        port,
        ...launchConfiguration,
      }),
      health: async () => running
        && Boolean(proxyServer?.listening)
        && targetServer.listening
        && await probeReadiness(readyRecord, options.readinessToken, 500),
      cleanup: () => {
        cleanupPromise ??= (async () => {
          running = false;
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await Promise.allSettled([
            closeServer(proxyServer!),
            closeServer(targetServer),
          ]);
          await removeReadyIfOwned(options.readinessPath, options.readinessToken);
          markClosed();
          await options.diagnostics.flush();
        })();
        return cleanupPromise;
      },
    };
    return handle;
  } catch (error) {
    running = false;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (proxyServer) await closeServer(proxyServer).catch(() => {});
    await closeServer(targetServer).catch(() => {});
    await removeReadyIfOwned(options.readinessPath, options.readinessToken).catch(() => {});
    markClosed();
    throw error;
  }
}

function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  readinessToken: string,
  port: number,
): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    response.writeHead(403, { 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === PAC_PATH) {
    const body = Buffer.from(buildPac(port));
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-ns-proxy-autoconfig',
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
    return;
  }
  if (
    request.method === 'GET'
    && request.url === READINESS_PATH
    && request.headers['x-attune-readiness-token'] === readinessToken
  ) {
    response.writeHead(204, { 'cache-control': 'no-store' });
    response.end();
    return;
  }
  response.writeHead(404, { 'cache-control': 'no-store', 'content-length': '0' });
  response.end();
}

function buildPac(port: number): string {
  return [
    'function FindProxyForURL(url, host) {',
    `  return String(host).toLowerCase() === ${JSON.stringify(TARGET_HOST)}`,
    `    ? ${JSON.stringify(`PROXY 127.0.0.1:${port}`)}`,
    "    : 'DIRECT';",
    '}',
    '',
  ].join('\n');
}

function handleConnect(
  request: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  targetPort: number,
  options: NormalizedOptions,
  sockets: Set<Socket>,
): void {
  const requestId = createRoutingDiagnosticId();
  const startedAt = Date.now();
  if (!isLoopbackAddress(clientSocket.remoteAddress)) {
    options.diagnostics.write('proxy', 'connectRejected', {
      requestId,
      authorityClass: 'invalid',
      status: 403,
      reason: 'nonLoopback',
    });
    rejectConnect(clientSocket);
    return;
  }
  const authority = parseConnectAuthority(request.url);
  if (!authority) {
    options.diagnostics.write('proxy', 'connectRejected', {
      requestId,
      authorityClass: 'invalid',
      status: 403,
      reason: 'invalidAuthority',
    });
    rejectConnect(clientSocket);
    return;
  }
  const authorityClass = authority.normalized === TARGET_AUTHORITY
    ? 'claudeWeb'
    : authority.normalized === ANTHROPIC_API_AUTHORITY
      ? 'anthropicApi'
      : 'other';
  const authorizationPresented = typeof request.headers['proxy-authorization'] === 'string';

  let targetSocket: Socket;
  let route: 'claudeWeb' | 'gptRouter' | 'passthrough';
  if (authority.normalized === TARGET_AUTHORITY) {
    route = 'claudeWeb';
    targetSocket = connectTcp(targetPort, '127.0.0.1');
  } else {
    if (!options.proxyAuthorization) {
      options.diagnostics.write('proxy', 'connectRejected', {
        requestId,
        authorityClass,
        authorizationPresented,
        status: 403,
        reason: 'proxyDisabled',
      });
      rejectConnect(clientSocket);
      return;
    }
    if (!hasProxyAuthorization(request.headers['proxy-authorization'], options.proxyAuthorization)) {
      options.diagnostics.write('proxy', 'connectRejected', {
        requestId,
        authorityClass,
        authorizationPresented,
        status: 407,
        reason: 'proxyAuthorization',
      });
      rejectConnect(clientSocket, 407);
      return;
    }
    if (authority.normalized === ANTHROPIC_API_AUTHORITY) {
      if (!options.anthropicSocketPath) {
        options.diagnostics.write('proxy', 'connectRejected', {
          requestId,
          authorityClass,
          authorizationPresented,
          status: 403,
          reason: 'routerUnavailable',
        });
        rejectConnect(clientSocket);
        return;
      }
      route = 'gptRouter';
      targetSocket = connectTcp(options.anthropicSocketPath);
    } else {
      route = 'passthrough';
      targetSocket = connectTcp(authority.port, authority.hostname);
    }
  }
  options.diagnostics.write('proxy', 'connectAccepted', {
    requestId,
    authorityClass,
    authorizationPresented,
    route,
  });
  sockets.add(targetSocket);
  targetSocket.once('close', () => sockets.delete(targetSocket));
  targetSocket.once('connect', () => {
    options.diagnostics.write('proxy', 'connectEstablished', {
      requestId,
      authorityClass,
      route,
      durationMs: Date.now() - startedAt,
    });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Attune\r\n\r\n');
    if (head.length > 0) targetSocket.write(head);
    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  });
  targetSocket.once('error', (error: Error) => {
    options.diagnostics.write('proxy', 'connectFailed', {
      requestId,
      authorityClass,
      route,
      durationMs: Date.now() - startedAt,
      errorCode: routingErrorCode(error),
    });
    if (!clientSocket.destroyed) rejectConnect(clientSocket, 502);
  });
  clientSocket.once('error', () => targetSocket.destroy());
}

function parseConnectAuthority(
  rawAuthority: string | undefined,
): { hostname: string; port: number; normalized: string } | null {
  if (!rawAuthority || /[\r\n\0/?#@]/.test(rawAuthority)) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${rawAuthority}`);
  } catch {
    return null;
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!parsed.hostname || !Number.isInteger(port) || port !== 443) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return { hostname, port, normalized: `${hostname}:${port}` };
}

function hasProxyAuthorization(
  header: string | string[] | undefined,
  expected: string | null,
): boolean {
  if (!expected || typeof header !== 'string') return false;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function rejectConnect(socket: Socket, status = 403): void {
  if (socket.destroyed) return;
  const reason = status === 502
    ? 'Bad Gateway'
    : status === 407
      ? 'Proxy Authentication Required'
      : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function handleTargetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
  selections: SelectionStore,
  policyState: RuntimePolicyState,
): Promise<void> {
  if (!hasExactTargetHost(request.headers.host)) {
    response.writeHead(421, { 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
    return;
  }
  const method = request.method?.toUpperCase() ?? '';
  const bootstrapContext = method === 'GET' ? parseBootstrapPath(request.url) : null;
  if (bootstrapContext) {
    await forwardBootstrap(
      request,
      response,
      options,
      bootstrapContext.pathOrgUuid,
      selections,
      policyState,
    );
    return;
  }
  const selectionOrgUuid = method === 'PATCH' ? parseSelectionPath(request.url) : null;
  if (selectionOrgUuid) {
    await handleSelectionPatch(
      request,
      response,
      options,
      selectionOrgUuid,
      selections,
      policyState.organizationContexts,
    );
    return;
  }
  forwardStreaming(request, response, options);
}

async function forwardBootstrap(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
  pathOrgUuid: string | null,
  selections: SelectionStore,
  policyState: RuntimePolicyState,
): Promise<void> {
  const bootstrapGeneration = ++policyState.nextBootstrapGeneration;
  if (pathOrgUuid) {
    policyState.organizationGenerations.set(pathOrgUuid, bootstrapGeneration);
    policyState.organizationContexts.delete(pathOrgUuid);
  } else {
    policyState.latestGenericGeneration = bootstrapGeneration;
    policyState.organizationContexts.clear();
  }
  const requestHeaders = sanitizeRequestHeaders(request.headers);
  for (const conditional of [
    'if-match',
    'if-none-match',
    'if-modified-since',
    'if-unmodified-since',
    'if-range',
    'range',
  ]) delete requestHeaders[conditional];
  requestHeaders['cache-control'] = 'no-cache';
  requestHeaders.pragma = 'no-cache';
  const upstreamRequest = createTargetRequest(request, options, {
    ...requestHeaders,
    'accept-encoding': 'identity',
  });
  wireRequestAbort(request, response, upstreamRequest);
  upstreamRequest.once('response', upstreamResponse => {
    void (async () => {
      if (!isPotentiallyTransformableJsonResponse(upstreamResponse)) {
        pipeUpstreamResponse(upstreamResponse, response);
        return;
      }
      const body = await bufferOrPassThroughResponse(
        upstreamResponse,
        response,
        options.maxBootstrapBytes,
      );
      if (!body) return;
      const decodedBody = await decodeBootstrapBody(
        body,
        upstreamResponse.headers['content-encoding'],
        options.maxBootstrapBytes,
      );
      if (!decodedBody) {
        sendBufferedResponse(upstreamResponse, response, body);
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(decodedBody.toString('utf8'));
      } catch {
        sendBufferedResponse(upstreamResponse, response, body);
        return;
      }
      const analysis = analyzeBootstrap(payload, pathOrgUuid);
      const generationIsCurrent = analysis?.orgUuid && pathOrgUuid
        ? policyState.organizationGenerations.get(pathOrgUuid) === bootstrapGeneration
        : analysis?.orgUuid
          ? policyState.latestGenericGeneration === bootstrapGeneration
            && (policyState.organizationGenerations.get(analysis.orgUuid) ?? 0) <= bootstrapGeneration
          : false;
      if (
        !analysis
        || !analysis.accountUuid
        || !analysis.orgUuid
        || !generationIsCurrent
      ) {
        sendBufferedResponse(upstreamResponse, response, body);
        return;
      }
      if (!analysis.aliasesAllowed) {
        try {
          await selections.clear(analysis.accountUuid, analysis.orgUuid);
        } catch {
          sendBufferedResponse(upstreamResponse, response, body);
          return;
        }
      }
      if (
        policyState.activeAccountUuid
        && policyState.activeAccountUuid !== analysis.accountUuid
      ) {
        if (bootstrapGeneration < policyState.activeAccountGeneration) {
          sendBufferedResponse(upstreamResponse, response, body);
          return;
        }
        policyState.organizationContexts.clear();
      }
      policyState.activeAccountUuid = analysis.accountUuid;
      policyState.activeAccountGeneration = Math.max(
        policyState.activeAccountGeneration,
        bootstrapGeneration,
      );
      policyState.organizationContexts.set(analysis.orgUuid, {
        accountUuid: analysis.accountUuid,
        orgUuid: analysis.orgUuid,
        aliasesAllowed: analysis.aliasesAllowed,
        nativeModelIds: new Set(analysis.nativeModelIds),
      });
      const selectedAlias = analysis.aliasesAllowed
        ? selections.get(analysis.accountUuid, analysis.orgUuid)
        : null;
      let transformed: Buffer;
      try {
        transformed = Buffer.from(JSON.stringify(augmentBootstrap(analysis, selectedAlias)));
      } catch {
        sendBufferedResponse(upstreamResponse, response, body);
        return;
      }
      const headers = sanitizeResponseHeaders(upstreamResponse.headers);
      delete headers['content-encoding'];
      delete headers.etag;
      delete headers['content-md5'];
      delete headers['last-modified'];
      delete headers['content-range'];
      delete headers.digest;
      delete headers['content-digest'];
      delete headers['repr-digest'];
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(transformed.length);
      headers['cache-control'] = 'no-store';
      response.writeHead(upstreamResponse.statusCode ?? 200, headers);
      response.end(transformed);
    })().catch(() => failResponse(response));
  });
  upstreamRequest.once('error', () => failResponse(response));
  void pipeline(request, upstreamRequest).catch(() => upstreamRequest.destroy());
}

async function handleSelectionPatch(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
  orgUuid: string,
  selections: SelectionStore,
  organizationContexts: Map<string, OrganizationContext>,
): Promise<void> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    forwardStreaming(request, response, options);
    return;
  }
  const buffered = await readBoundedRequest(request, options.maxSelectionBytes);
  if (buffered.kind === 'overflow') {
    forwardRequestIterator(request, response, options, buffered.chunks, buffered.iterator);
    return;
  }
  const selection = parseSelectionBody(buffered.body, options.maxSelectionBytes);
  const context = organizationContexts.get(orgUuid);
  if (!selection || !context || context.orgUuid !== orgUuid) {
    forwardBufferedRequest(request, response, options, buffered.body);
    return;
  }
  if (ALIAS_BY_ID.has(selection.model)) {
    if (!context.aliasesAllowed || selection.thinking != null) {
      forwardBufferedRequest(request, response, options, buffered.body);
      return;
    }
    try {
      await selections.set(context.accountUuid, orgUuid, selection.model);
    } catch {
      forwardBufferedRequest(request, response, options, buffered.body);
      return;
    }
    const body = Buffer.from(JSON.stringify({
      thinking: null,
      thinking_by_model: null,
      id: 'code',
      model: selection.model,
      source: 'user_setting',
    }));
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
    });
    response.end(body);
    return;
  }
  forwardBufferedRequest(
    request,
    response,
    options,
    buffered.body,
    context.nativeModelIds.has(selection.model)
      ? async statusCode => {
        if (statusCode >= 200 && statusCode < 300) {
          await selections.clear(context.accountUuid, orgUuid);
        }
      }
      : undefined,
  );
}

function forwardStreaming(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
): void {
  const upstreamRequest = createTargetRequest(request, options, sanitizeRequestHeaders(request.headers));
  wireRequestAbort(request, response, upstreamRequest);
  upstreamRequest.once('response', upstreamResponse => pipeUpstreamResponse(upstreamResponse, response));
  upstreamRequest.once('error', () => failResponse(response));
  void pipeline(request, upstreamRequest).catch(() => upstreamRequest.destroy());
}

function forwardBufferedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
  body: Buffer,
  onResponse?: (statusCode: number) => Promise<void>,
): void {
  const headers = sanitizeRequestHeaders(request.headers);
  headers['content-length'] = String(body.length);
  const upstreamRequest = createTargetRequest(request, options, headers);
  wireRequestAbort(request, response, upstreamRequest);
  upstreamRequest.once('response', upstreamResponse => {
    void (async () => {
      if (onResponse) await onResponse(upstreamResponse.statusCode ?? 502);
      pipeUpstreamResponse(upstreamResponse, response);
    })().catch(() => pipeUpstreamResponse(upstreamResponse, response));
  });
  upstreamRequest.once('error', () => failResponse(response));
  upstreamRequest.end(body);
}

function forwardRequestIterator(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedOptions,
  chunks: Buffer[],
  iterator: AsyncIterator<unknown>,
): void {
  const headers = sanitizeRequestHeaders(request.headers);
  delete headers['content-length'];
  const upstreamRequest = createTargetRequest(request, options, headers);
  wireRequestAbort(request, response, upstreamRequest);
  upstreamRequest.once('response', upstreamResponse => pipeUpstreamResponse(upstreamResponse, response));
  upstreamRequest.once('error', () => failResponse(response));
  void (async () => {
    for (const chunk of chunks) await writeWithBackpressure(upstreamRequest, chunk);
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      await writeWithBackpressure(upstreamRequest, Buffer.from(next.value as Uint8Array));
    }
    upstreamRequest.end();
  })().catch(() => upstreamRequest.destroy());
}

function handleTargetUpgrade(
  request: IncomingMessage,
  clientSocket: Socket,
  clientHead: Buffer,
  options: NormalizedOptions,
  sockets: Set<Socket>,
): void {
  if (!hasExactTargetHost(request.headers.host)) {
    clientSocket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const headers = sanitizeUpgradeHeaders(request.headers);
  const upstreamRequest = createTargetRequest(request, options, headers);
  const closePendingUpgrade = () => upstreamRequest.destroy();
  clientSocket.once('close', closePendingUpgrade);
  clientSocket.once('error', closePendingUpgrade);
  upstreamRequest.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    clientSocket.off('close', closePendingUpgrade);
    clientSocket.off('error', closePendingUpgrade);
    const socket = upstreamSocket as Socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const closePeerFromClient = () => socket.destroy();
    const closePeerFromUpstream = () => clientSocket.destroy();
    clientSocket.once('error', closePeerFromClient);
    clientSocket.once('close', closePeerFromClient);
    socket.once('error', closePeerFromUpstream);
    socket.once('close', closePeerFromUpstream);
    clientSocket.write(serializeResponseHead(upstreamResponse));
    if (clientHead.length > 0) socket.write(clientHead);
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    clientSocket.pipe(socket);
    socket.pipe(clientSocket);
  });
  upstreamRequest.once('response', upstreamResponse => {
    clientSocket.off('close', closePendingUpgrade);
    clientSocket.off('error', closePendingUpgrade);
    clientSocket.write(serializeResponseHead(upstreamResponse));
    upstreamResponse.pipe(clientSocket);
  });
  upstreamRequest.once('error', () => clientSocket.destroy());
  upstreamRequest.end();
}

function createTargetRequest(
  request: IncomingMessage,
  options: NormalizedOptions,
  headers: IncomingHttpHeaders,
): ClientRequest {
  const targetUrl = new URL(request.url ?? '/', options.targetUpstream);
  const requestFunction = options.targetUpstream.protocol === 'https:' ? httpsRequest : httpRequest;
  return requestFunction({
    protocol: options.targetUpstream.protocol,
    hostname: options.targetUpstream.hostname,
    port: options.targetUpstream.port || undefined,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: request.method,
    headers: { ...headers, host: TARGET_HOST },
    agent: false,
    ...(options.targetUpstream.protocol === 'https:'
      ? { servername: options.targetUpstream.hostname, rejectUnauthorized: true }
      : {}),
  });
}

function sanitizeRequestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionHeaders = new Set(
    String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  );
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionHeaders.has(lower) || lower === 'host') continue;
    result[lower] = value;
  }
  return result;
}

function sanitizeUpgradeHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'proxy-authorization' || lower === 'proxy-authenticate' || lower === 'host') continue;
    result[lower] = value;
  }
  return result;
}

function sanitizeResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connectionHeaders = new Set(
    String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  );
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionHeaders.has(lower)) continue;
    result[lower] = value;
  }
  return result;
}

function pipeUpstreamResponse(upstream: IncomingMessage, response: ServerResponse): void {
  if (response.headersSent || response.destroyed) {
    upstream.destroy();
    return;
  }
  response.writeHead(upstream.statusCode ?? 502, sanitizeResponseHeaders(upstream.headers));
  void pipeline(upstream, response).catch(() => response.destroy());
}

function sendBufferedResponse(upstream: IncomingMessage, response: ServerResponse, body: Buffer): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(upstream.statusCode ?? 502, sanitizeResponseHeaders(upstream.headers));
  response.end(body);
}

async function bufferOrPassThroughResponse(
  upstream: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = upstream[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) return Buffer.concat(chunks, total);
    const chunk = Buffer.from(next.value as Uint8Array);
    chunks.push(chunk);
    total += chunk.length;
    if (total <= maxBytes) continue;

    response.writeHead(upstream.statusCode ?? 502, sanitizeResponseHeaders(upstream.headers));
    for (const buffered of chunks) await writeWithBackpressure(response, buffered);
    while (true) {
      const remainder = await iterator.next();
      if (remainder.done) break;
      await writeWithBackpressure(response, Buffer.from(remainder.value as Uint8Array));
    }
    response.end();
    return null;
  }
}

async function readBoundedRequest(
  request: IncomingMessage,
  maxBytes: number,
): Promise<
  | { kind: 'buffer'; body: Buffer }
  | { kind: 'overflow'; chunks: Buffer[]; iterator: AsyncIterator<unknown> }
> {
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = request[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) return { kind: 'buffer', body: Buffer.concat(chunks, total) };
    const chunk = Buffer.from(next.value as Uint8Array);
    chunks.push(chunk);
    total += chunk.length;
    if (total > maxBytes) return { kind: 'overflow', chunks, iterator };
  }
}

function isPotentiallyTransformableJsonResponse(response: IncomingMessage): boolean {
  const status = response.statusCode ?? 0;
  const contentType = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  const contentEncoding = response.headers['content-encoding']?.trim().toLowerCase();
  return status === 200
    && contentType === 'application/json'
    && (!contentEncoding
      || contentEncoding === 'identity'
      || contentEncoding === 'gzip'
      || contentEncoding === 'x-gzip'
      || contentEncoding === 'deflate'
      || contentEncoding === 'br');
}

async function decodeBootstrapBody(
  body: Buffer,
  rawEncoding: string | undefined,
  maxBytes: number,
): Promise<Buffer | null> {
  const encoding = rawEncoding?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return body;
  let decoder: Transform;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  else return null;

  return await new Promise(resolveDecode => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolveDecode(value);
    };
    decoder.on('data', chunk => {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        decoder.destroy();
        finish(null);
        return;
      }
      chunks.push(buffer);
    });
    decoder.once('end', () => finish(Buffer.concat(chunks, total)));
    decoder.once('error', () => finish(null));
    Readable.from([body]).pipe(decoder);
  });
}

function writeWithBackpressure(
  stream: ServerResponse | ClientRequest,
  chunk: Buffer,
): Promise<void> {
  if (stream.destroyed) return Promise.reject(new Error('stream closed'));
  if (stream.write(chunk)) return Promise.resolve();
  return new Promise((resolveWrite, rejectWrite) => {
    const cleanup = () => {
      stream.off('drain', onDrain);
      stream.off('error', onFailure);
      stream.off('close', onFailure);
    };
    const onDrain = () => {
      cleanup();
      resolveWrite();
    };
    const onFailure = () => {
      cleanup();
      rejectWrite(new Error('stream write failed'));
    };
    stream.once('drain', onDrain);
    stream.once('error', onFailure);
    stream.once('close', onFailure);
  });
}

function wireRequestAbort(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: ClientRequest,
): void {
  request.once('aborted', () => upstream.destroy());
  response.once('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
}

function failResponse(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(502, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
  });
  response.end('{"error":"Claude upstream unavailable"}');
}

function serializeResponseHead(response: IncomingMessage): string {
  const status = response.statusCode ?? 502;
  const reason = response.statusMessage || 'Bad Gateway';
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function hasExactTargetHost(host: string | undefined): boolean {
  return host?.toLowerCase() === TARGET_HOST || host?.toLowerCase() === TARGET_AUTHORITY;
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function trackServerSockets(server: HttpServer | HttpsServer, sockets: Set<Socket>): void {
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
}

function listenLoopback(server: HttpServer | HttpsServer, port: number): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen(proxyServerPort(server));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function proxyServerPort(server: HttpServer | HttpsServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy did not bind a TCP port.');
  return address.port;
}

function closeServer(server: HttpServer | HttpsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
}
