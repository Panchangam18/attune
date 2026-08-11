import { execFile } from 'node:child_process';
import {
  randomBytes,
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
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server as HttpServer,
  type ServerResponse,
  request as httpRequest,
} from 'node:http';
import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from 'node:https';
import { connect as connectSocket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';
import {
  createRoutingDiagnosticId,
  createRoutingDiagnostics,
  routingErrorCode,
  type RoutingDiagnostics,
} from './claude-gpt-diagnostics.js';

const execFileAsync = promisify(execFile);

const DEFAULT_NATIVE_UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_GPT_UPSTREAM = 'http://127.0.0.1:8317';
const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_SOCKET_TAKEOVER_TIMEOUT_MS = 10_000;
const CERTIFICATE_HOSTNAME = 'api.anthropic.com';
const READINESS_PATH = '/.attune/claude-gpt-router/ready';
const ROUTER_PROTOCOL_VERSION = '1';
const ROUTABLE_MESSAGE_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);

/**
 * These aliases are intentionally exact. A prefix or a newly invented model
 * name must never cause a request to leave Anthropic's first-party endpoint.
 */
export const CLAUDE_GPT_MODEL_ALIASES = Object.freeze([
  'claude-opus-4-8-attune-sol',
  'claude-sonnet-4-8-attune-terra',
  'claude-haiku-4-8-attune-luna',
] as const);

const GPT_IDENTITY_PROMPT_VERSION = '1';

interface ClaudeGptModelIdentity {
  displayName: string;
  upstreamModel: string;
}

const CLAUDE_GPT_MODEL_IDENTITIES = new Map<string, Readonly<ClaudeGptModelIdentity>>([
  ['claude-opus-4-8-attune-sol', Object.freeze({
    displayName: 'GPT-5.6 Sol',
    upstreamModel: 'gpt-5.6-sol',
  })],
  ['claude-sonnet-4-8-attune-terra', Object.freeze({
    displayName: 'GPT-5.6 Terra',
    upstreamModel: 'gpt-5.6-terra',
  })],
  ['claude-haiku-4-8-attune-luna', Object.freeze({
    displayName: 'GPT-5.6 Luna',
    upstreamModel: 'gpt-5.6-luna',
  })],
]);

const GPT_IDENTITY_PROMPT_MARKER = `<attune_model_identity version="${GPT_IDENTITY_PROMPT_VERSION}">`;

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

const GPT_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'content-type',
  'anthropic-version',
  'anthropic-beta',
]);

export interface ClaudeGptTlsRouterEnvironment {
  ANTHROPIC_UNIX_SOCKET: string;
  SSL_CERT_FILE: string;
  NODE_EXTRA_CA_CERTS: string;
  ANTHROPIC_BASE_URL?: string;
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL?: string;
}

export interface ClaudeGptTlsRouterStatus {
  running: boolean;
  socketPath: string;
  httpPort: number | null;
  caCertificatePath: string;
  gptModelAliases: readonly string[];
}

export interface ClaudeGptTlsRouterHandle {
  readonly env: Readonly<ClaudeGptTlsRouterEnvironment>;
  readonly socketPath: string;
  readonly httpPort: number | null;
  readonly caCertificatePath: string;
  status(): ClaudeGptTlsRouterStatus;
  health(): Promise<boolean>;
  cleanup(): Promise<void>;
}

export interface ClaudeGptTlsRouterOptions {
  /** Defaults to ~/.attune/claude-gpt-router. Primarily overridable for tests. */
  stateDirectory?: string;
  /** Defaults to <stateDirectory>/api.anthropic.com.sock. */
  socketPath?: string;
  /**
   * Optional authenticated loopback base-URL listener for Claude Code builds
   * that expose ANTHROPIC_UNIX_SOCKET but no longer use it for API requests.
   */
  httpPort?: number;
  /** Defaults to ~/.cli-proxy-api/client.key. */
  credentialPath?: string;
  /** Defaults to https://api.anthropic.com. */
  nativeUpstream?: string | URL;
  /** Defaults to http://127.0.0.1:8317 and must stay on a loopback host. */
  gptUpstream?: string | URL;
  /** Defaults to the three model aliases exported above. */
  gptModelAliases?: readonly string[];
  /** Defaults to /usr/bin/openssl. */
  opensslPath?: string;
  /** Maximum buffered request size. Defaults to 64 MiB. */
  maxRequestBodyBytes?: number;
  /**
   * Per-launch handshake token shared by launch and its new watcher. Using a
   * fresh token prevents launch from accepting a previous watcher's router.
   */
  readinessToken?: string;
  /** How long a new watcher waits for an old watcher to release the UDS. */
  socketTakeoverTimeoutMs?: number;
  /** Optional privacy-safe JSONL event log. Disabled unless explicitly set. */
  diagnosticsPath?: string;
  /** Test-only escape hatch for an HTTP mock of api.anthropic.com. */
  allowInsecureNativeUpstream?: boolean;
}

interface CertificatePaths {
  caKey: string;
  caCertificate: string;
  leafKey: string;
  leafCertificate: string;
}

interface CertificateMaterial {
  paths: CertificatePaths;
  caCertificate: Buffer;
  leafKey: Buffer;
  leafCertificate: Buffer;
}

interface NormalizedRouterOptions {
  stateDirectory: string;
  socketPath: string;
  httpPort: number | null;
  credentialPath: string;
  nativeUpstream: URL;
  gptUpstream: URL;
  gptModelAliases: ReadonlySet<string>;
  opensslPath: string;
  maxRequestBodyBytes: number;
  readinessToken: string;
  socketTakeoverTimeoutMs: number;
  diagnostics: RoutingDiagnostics;
}

type BoundedRequest =
  | { kind: 'buffer'; body: Buffer }
  | { kind: 'overflow'; chunks: Buffer[]; iterator: AsyncIterator<unknown> };

const activeRouters = new Map<string, Promise<ClaudeGptTlsRouterHandle>>();
const activeRouterTokens = new Map<string, string>();
const certificateJobs = new Map<string, Promise<CertificateMaterial>>();

/** Creates a non-secret, per-launch nonce for the watcher readiness handshake. */
export function createClaudeGptTlsRouterReadinessToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Resolves the two child-process variables without starting the router or
 * mutating process.env. This lets a short-lived launcher prepare Claude's env
 * while a detached Attune watcher owns the router lifecycle.
 */
export function getClaudeGptTlsRouterEnvironment(
  options: ClaudeGptTlsRouterOptions = {},
): Readonly<ClaudeGptTlsRouterEnvironment> {
  return routerEnvironment(normalizeOptions(options));
}

/**
 * Waits for a CA-validated HTTPS readiness response over the Unix socket.
 * A launcher should complete this handshake before it starts Claude Desktop.
 */
export async function waitForClaudeGptTlsRouter(
  options: ClaudeGptTlsRouterOptions = {},
  timeoutMs = 10_000,
): Promise<Readonly<ClaudeGptTlsRouterEnvironment>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error('The Claude GPT router readiness timeout must be between 1 and 60000 ms.');
  }
  const normalized = normalizeOptions(options);
  const env = routerEnvironment(normalized);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const ca = await readFile(env.SSL_CERT_FILE);
      const probeTimeoutMs = Math.min(500, Math.max(1, deadline - Date.now()));
      const socketReady = await probeRouterReadiness(
        env.ANTHROPIC_UNIX_SOCKET,
        ca,
        normalized.readinessToken,
        probeTimeoutMs,
      );
      const httpReady = normalized.httpPort === null
        || await probeHttpRouterReadiness(normalized, probeTimeoutMs);
      if (socketReady && httpReady) return env;
    } catch {
      // The watcher may still be generating certificate material or binding.
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new Error('The Claude GPT router did not become ready before launch.');
}

/**
 * Starts (or reuses in-process) the user-scoped selective TLS router used by
 * Claude Desktop. The returned environment is meant for the Claude/Bun child,
 * not the whole Attune process.
 */
export function ensureClaudeGptTlsRouter(
  options: ClaudeGptTlsRouterOptions = {},
): Promise<ClaudeGptTlsRouterHandle> {
  const normalized = normalizeOptions(options);
  const existing = activeRouters.get(normalized.socketPath);
  if (existing) {
    if (activeRouterTokens.get(normalized.socketPath) !== normalized.readinessToken) {
      throw new Error('This process already owns the Claude GPT router for another launch.');
    }
    return existing;
  }

  let startPromise: Promise<ClaudeGptTlsRouterHandle>;
  startPromise = startRouter(normalized, () => {
    if (activeRouters.get(normalized.socketPath) === startPromise) {
      activeRouters.delete(normalized.socketPath);
      activeRouterTokens.delete(normalized.socketPath);
    }
  }).catch((error: unknown) => {
    if (activeRouters.get(normalized.socketPath) === startPromise) {
      activeRouters.delete(normalized.socketPath);
      activeRouterTokens.delete(normalized.socketPath);
    }
    throw error;
  });
  activeRouters.set(normalized.socketPath, startPromise);
  activeRouterTokens.set(normalized.socketPath, normalized.readinessToken);
  return startPromise;
}

function normalizeOptions(options: ClaudeGptTlsRouterOptions): NormalizedRouterOptions {
  const stateDirectory = resolve(
    options.stateDirectory ?? join(homedir(), '.attune', 'claude-gpt-router'),
  );
  if (stateDirectory === resolve('/') || stateDirectory === resolve(homedir())) {
    throw new Error('The Claude GPT router state directory is too broad.');
  }
  const socketPath = resolve(options.socketPath ?? join(stateDirectory, 'api.anthropic.com.sock'));
  if (dirname(socketPath) !== stateDirectory) {
    throw new Error('The Claude GPT router socket must be directly inside its private state directory.');
  }

  const nativeUpstream = new URL(options.nativeUpstream ?? DEFAULT_NATIVE_UPSTREAM);
  const gptUpstream = new URL(options.gptUpstream ?? DEFAULT_GPT_UPSTREAM);
  validateUpstream(nativeUpstream, 'native', options.allowInsecureNativeUpstream === true);
  validateUpstream(gptUpstream, 'gpt', false);
  if (!isLoopbackHostname(gptUpstream.hostname)) {
    throw new Error('The GPT gateway must use a loopback hostname.');
  }

  const aliases = options.gptModelAliases ?? CLAUDE_GPT_MODEL_ALIASES;
  if (aliases.some(alias => typeof alias !== 'string' || alias.length === 0)) {
    throw new Error('GPT model aliases must be non-empty strings.');
  }

  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new Error('maxRequestBodyBytes must be a positive safe integer.');
  }
  const readinessToken = options.readinessToken ?? '';
  if (readinessToken && !/^[A-Za-z0-9_-]{16,128}$/.test(readinessToken)) {
    throw new Error('The Claude GPT router readiness token is invalid.');
  }
  const httpPort = options.httpPort ?? null;
  if (httpPort !== null && (
    !Number.isSafeInteger(httpPort)
    || httpPort < 1
    || httpPort > 65_535
  )) {
    throw new Error('The Claude GPT router HTTP port must be between 1 and 65535.');
  }
  if (httpPort !== null && !readinessToken) {
    throw new Error('The Claude GPT router HTTP listener requires a readiness token.');
  }
  const socketTakeoverTimeoutMs = options.socketTakeoverTimeoutMs
    ?? DEFAULT_SOCKET_TAKEOVER_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(socketTakeoverTimeoutMs)
    || socketTakeoverTimeoutMs < 0
    || socketTakeoverTimeoutMs > 60_000
  ) {
    throw new Error('socketTakeoverTimeoutMs must be between 0 and 60000 ms.');
  }

  return {
    stateDirectory,
    socketPath,
    httpPort,
    credentialPath: resolve(
      options.credentialPath ?? join(homedir(), '.cli-proxy-api', 'client.key'),
    ),
    nativeUpstream,
    gptUpstream,
    gptModelAliases: new Set(aliases),
    opensslPath: options.opensslPath ?? '/usr/bin/openssl',
    maxRequestBodyBytes,
    readinessToken,
    socketTakeoverTimeoutMs,
    diagnostics: createRoutingDiagnostics(options.diagnosticsPath),
  };
}

function validateUpstream(url: URL, kind: 'native' | 'gpt', allowHttp: boolean): void {
  if (url.username || url.password || url.hash) {
    throw new Error(`${kind} upstream URLs cannot contain credentials or fragments.`);
  }
  if (kind === 'native') {
    const isProduction = url.protocol === 'https:'
      && url.hostname === CERTIFICATE_HOSTNAME
      && !url.port
      && url.pathname === '/'
      && !url.search;
    const isTest = allowHttp
      && isLoopbackHostname(url.hostname)
      && (url.protocol === 'http:' || url.protocol === 'https:')
      && url.pathname === '/'
      && !url.search;
    if (!isProduction && !isTest) {
      throw new Error('The native upstream must be exact or an explicit loopback test origin.');
    }
    return;
  }
  if (!isLoopbackHostname(url.hostname)
    || (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.pathname !== '/'
    || url.search) {
    throw new Error('The GPT upstream must be an exact loopback origin.');
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function startRouter(
  options: NormalizedRouterOptions,
  onClosed: () => void,
): Promise<ClaudeGptTlsRouterHandle> {
  await ensurePrivateDirectory(options.stateDirectory);
  const material = await ensureCertificateMaterial(options);
  await waitForSocketTakeover(options.socketPath, options.socketTakeoverTimeoutMs);

  const server = createHttpsServer({
    key: material.leafKey,
    cert: material.leafCertificate,
  }, (request, response) => {
    void handleRequest(request, response, options, {
      expectedHost: CERTIFICATE_HOSTNAME,
      pathPrefix: '',
      requireLoopback: false,
      transport: 'tlsSocket',
    });
  });
  server.on('tlsClientError', () => {
    // TLS failures are intentionally silent: they can contain request metadata.
  });

  await listenOnSocket(server, options.socketPath);
  server.on('error', () => {
    // Runtime socket errors are reflected by server.listening/status. They must
    // not crash the watcher or print request-adjacent metadata.
  });
  await chmod(options.socketPath, 0o600);
  const socketIdentity = await lstat(options.socketPath);
  let httpServer: HttpServer | null = null;
  if (options.httpPort !== null) {
    const pathPrefix = routerHttpPathPrefix(options.readinessToken);
    httpServer = createHttpServer((request, response) => {
      void handleRequest(request, response, options, {
        expectedHost: `127.0.0.1:${options.httpPort}`,
        pathPrefix,
        requireLoopback: true,
        transport: 'httpLoopback',
      });
    });
    httpServer.on('clientError', (_error, socket) => socket.destroy());
    httpServer.on('error', () => {
      // Health/status report listener failures without printing request data.
    });
    try {
      await listenOnLoopback(httpServer, options.httpPort);
    } catch (error) {
      await stopRouter(server, null, options.socketPath, socketIdentity.dev, socketIdentity.ino)
        .catch(() => {});
      throw error;
    }
  }
  server.unref();
  httpServer?.unref();
  options.diagnostics.write('router', 'started', {
    httpEnabled: options.httpPort !== null,
    aliasCount: options.gptModelAliases.size,
  });

  let running = true;
  let cleanupPromise: Promise<void> | null = null;
  const markClosed = () => {
    running = false;
    options.diagnostics.write('router', 'stopped');
    onClosed();
  };
  server.once('close', markClosed);
  httpServer?.once('close', markClosed);

  const env = Object.freeze({
    ...routerEnvironment(options),
  });

  const handle: ClaudeGptTlsRouterHandle = {
    env,
    socketPath: options.socketPath,
    httpPort: options.httpPort,
    caCertificatePath: material.paths.caCertificate,
    status: () => ({
      running: running
        && server.listening
        && (httpServer === null || httpServer.listening),
      socketPath: options.socketPath,
      httpPort: options.httpPort,
      caCertificatePath: material.paths.caCertificate,
      gptModelAliases: Object.freeze([...options.gptModelAliases]),
    }),
    health: async () => running
      && server.listening
      && (httpServer === null || httpServer.listening)
      && await probeRouterReadiness(
        options.socketPath,
        material.caCertificate,
        options.readinessToken,
        500,
      )
      && (options.httpPort === null || await probeHttpRouterReadiness(options, 500)),
    cleanup: () => {
      cleanupPromise ??= stopRouter(
        server,
        httpServer,
        options.socketPath,
        socketIdentity.dev,
        socketIdentity.ino,
      ).finally(() => options.diagnostics.flush());
      return cleanupPromise;
    },
  };
  return handle;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (directory === resolve('/') || directory === resolve(homedir())) {
    throw new Error('The Claude GPT router state directory is too broad.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The Claude GPT router state path must be a private directory.');
  }
  await chmod(directory, 0o700);
}

async function ensureCertificateMaterial(
  options: NormalizedRouterOptions,
): Promise<CertificateMaterial> {
  const existing = certificateJobs.get(options.stateDirectory);
  if (existing) return existing;

  let job: Promise<CertificateMaterial>;
  job = loadOrGenerateCertificateMaterial(options).finally(() => {
    if (certificateJobs.get(options.stateDirectory) === job) {
      certificateJobs.delete(options.stateDirectory);
    }
  });
  certificateJobs.set(options.stateDirectory, job);
  return job;
}

async function loadOrGenerateCertificateMaterial(
  options: NormalizedRouterOptions,
): Promise<CertificateMaterial> {
  const paths = certificatePaths(options.stateDirectory);
  try {
    const material = await loadCertificateMaterial(paths);
    await lockDownCertificateFiles(paths);
    return material;
  } catch {
    await generateCertificateMaterial(options, paths);
    const material = await loadCertificateMaterial(paths);
    await lockDownCertificateFiles(paths);
    return material;
  }
}

function certificatePaths(stateDirectory: string): CertificatePaths {
  return {
    caKey: join(stateDirectory, 'attune-router-ca-key.pem'),
    caCertificate: join(stateDirectory, 'attune-router-ca.pem'),
    leafKey: join(stateDirectory, 'api.anthropic.com-key.pem'),
    leafCertificate: join(stateDirectory, 'api.anthropic.com.pem'),
  };
}

async function loadCertificateMaterial(paths: CertificatePaths): Promise<CertificateMaterial> {
  const infos = await Promise.all(Object.values(paths).map(path => lstat(path)));
  if (infos.some(info => !info.isFile() || info.isSymbolicLink())) {
    throw new Error('The Claude GPT router certificate paths must be regular files.');
  }
  const [caKey, caCertificate, leafKey, leafCertificate] = await Promise.all([
    readFile(paths.caKey),
    readFile(paths.caCertificate),
    readFile(paths.leafKey),
    readFile(paths.leafCertificate),
  ]);
  if ([caKey, caCertificate, leafKey, leafCertificate].some(value => value.length === 0)) {
    throw new Error('The Claude GPT router certificate material is incomplete.');
  }

  createSecureContext({ key: leafKey, cert: leafCertificate });
  const ca = new X509Certificate(caCertificate);
  const leaf = new X509Certificate(leafCertificate);
  const caValidFrom = Date.parse(ca.validFrom);
  const caValidUntil = Date.parse(ca.validTo);
  const leafValidFrom = Date.parse(leaf.validFrom);
  const leafValidUntil = Date.parse(leaf.validTo);
  const now = Date.now();
  if (!ca.ca || !leaf.checkHost(CERTIFICATE_HOSTNAME) || !leaf.verify(ca.publicKey)) {
    throw new Error('The Claude GPT router certificate material is invalid.');
  }
  if (
    ![caValidFrom, caValidUntil, leafValidFrom, leafValidUntil].every(Number.isFinite)
    || caValidFrom > now
    || leafValidFrom > now
    || caValidUntil < now + 24 * 60 * 60 * 1000
    || leafValidUntil < now + 24 * 60 * 60 * 1000
  ) {
    throw new Error('The Claude GPT router certificate is expired or near expiry.');
  }
  return { paths, caCertificate, leafKey, leafCertificate };
}

async function lockDownCertificateFiles(paths: CertificatePaths): Promise<void> {
  await Promise.all(Object.values(paths).map(path => chmod(path, 0o600)));
}

async function generateCertificateMaterial(
  options: NormalizedRouterOptions,
  paths: CertificatePaths,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(options.stateDirectory, '.certificates-'));
  await chmod(temporaryDirectory, 0o700);
  const temporaryPaths = certificatePaths(temporaryDirectory);
  const caConfiguration = join(temporaryDirectory, 'ca.cnf');
  const leafRequest = join(temporaryDirectory, 'api.anthropic.com.csr');
  const leafExtensions = join(temporaryDirectory, 'leaf-extensions.cnf');

  try {
    await writeFile(caConfiguration, [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=v3_ca',
      'prompt=no',
      '[dn]',
      'CN=Attune Local Claude Router CA',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid:always',
      '',
    ].join('\n'), { mode: 0o600 });
    await runOpenSsl(options.opensslPath, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', temporaryPaths.caKey,
      '-out', temporaryPaths.caCertificate,
      '-config', caConfiguration,
    ]);
    await runOpenSsl(options.opensslPath, [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', temporaryPaths.leafKey,
      '-out', leafRequest,
      '-subj', `/CN=${CERTIFICATE_HOSTNAME}`,
    ]);
    await writeFile(leafExtensions, [
      `subjectAltName=DNS:${CERTIFICATE_HOSTNAME}`,
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'), { mode: 0o600 });
    await runOpenSsl(options.opensslPath, [
      'x509', '-req', '-sha256', '-days', '365',
      '-in', leafRequest,
      '-CA', temporaryPaths.caCertificate,
      '-CAkey', temporaryPaths.caKey,
      '-CAcreateserial',
      '-out', temporaryPaths.leafCertificate,
      '-extfile', leafExtensions,
    ]);

    await loadCertificateMaterial(temporaryPaths);
    await lockDownCertificateFiles(temporaryPaths);
    for (const name of Object.keys(paths) as Array<keyof CertificatePaths>) {
      await rename(temporaryPaths[name], paths[name]);
    }
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
    throw new Error('Attune could not generate the local Claude router certificate.');
  }
}

async function waitForSocketTakeover(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let info;
    try {
      info = await lstat(socketPath);
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) return;
      throw error;
    }
    if (!info.isSocket()) {
      throw new Error('The Claude GPT router socket path is occupied by a non-socket file.');
    }
    if (!await canConnect(socketPath)) {
      try {
        await unlink(socketPath);
        return;
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT')) return;
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('The previous Claude GPT router did not release its socket in time.');
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = connectSocket(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveProbe(true);
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
  });
}

function listenOnSocket(server: HttpsServer, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function listenOnLoopback(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function stopRouter(
  server: HttpsServer,
  httpServer: HttpServer | null,
  socketPath: string,
  socketDevice: number,
  socketInode: number,
): Promise<void> {
  await Promise.all([
    closeHttpServer(server),
    httpServer ? closeHttpServer(httpServer) : Promise.resolve(),
  ]);

  try {
    const info = await lstat(socketPath);
    if (info.isSocket() && info.dev === socketDevice && info.ino === socketInode) {
      await unlink(socketPath);
    }
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

function closeHttpServer(server: HttpServer | HttpsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => server.closeAllConnections(), 2_000);
    timer.unref();
    server.close(error => {
      clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    });
    server.closeIdleConnections();
  });
}

interface RouterRequestContext {
  expectedHost: string;
  pathPrefix: string;
  requireLoopback: boolean;
  transport: 'httpLoopback' | 'tlsSocket';
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NormalizedRouterOptions,
  context: RouterRequestContext,
): Promise<void> {
  const requestId = createRoutingDiagnosticId();
  try {
    if (context.requireLoopback && !isLoopbackAddress(request.socket.remoteAddress)) {
      request.resume();
      sendError(response, 403, 'The request did not originate on loopback.');
      return;
    }
    if (!hasExactRequestHost(request.headers.host, context.expectedHost)) {
      request.resume();
      sendError(response, 421, 'The request host is not accepted by this router.');
      return;
    }
    if (request.headers.upgrade) {
      sendError(response, 426, 'Protocol upgrades are not supported.');
      request.resume();
      return;
    }

    const requestPath = stripRouterHttpPathPrefix(
      safeRequestPath(request.url),
      context.pathPrefix,
    );
    if (requestPath === null) {
      request.resume();
      sendError(response, 403, 'The request is missing its launch-scoped route token.');
      return;
    }
    if (request.method === 'GET' && requestPath === READINESS_PATH) {
      request.resume();
      response.writeHead(204, {
        'x-attune-router-version': ROUTER_PROTOCOL_VERSION,
        ...(options.readinessToken
          ? { 'x-attune-router-token': options.readinessToken }
          : {}),
        'cache-control': 'no-store',
      });
      response.end();
      return;
    }
    const url = new URL(requestPath, `https://${CERTIFICATE_HOSTNAME}`);
    const isCandidate = request.method?.toUpperCase() === 'POST'
      && ROUTABLE_MESSAGE_PATHS.has(url.pathname);
    if (!isCandidate) {
      forwardStreamingRequest(request, response, requestPath, options.nativeUpstream);
      return;
    }

    options.diagnostics.write('router', 'messageRequestReceived', {
      requestId,
      transport: context.transport,
      requestPath: url.pathname,
    });

    const bounded = await readBoundedRequest(request, options.maxRequestBodyBytes);
    if (bounded.kind === 'overflow') {
      options.diagnostics.write('router', 'messageRequestBypassed', {
        requestId,
        transport: context.transport,
        route: 'nativeUpstream',
        reason: 'requestTooLarge',
      });
      forwardRequestIterator(
        request,
        response,
        requestPath,
        options.nativeUpstream,
        bounded.chunks,
        bounded.iterator,
      );
      return;
    }
    const model = classifyModelOrNative(request.headers, bounded.body);
    const isGptRequest = model !== null && options.gptModelAliases.has(model);
    options.diagnostics.write('router', 'messageRouteClassified', {
      requestId,
      transport: context.transport,
      route: isGptRequest ? 'gptGateway' : 'nativeUpstream',
      requestBytes: bounded.body.length,
    });

    if (isGptRequest) {
      const startedAt = Date.now();
      const identity = CLAUDE_GPT_MODEL_IDENTITIES.get(model);
      const identityRewrite = identity
        ? applyGptIdentityPrompt(bounded.body, identity)
        : null;
      const routedBody = identityRewrite?.body ?? bounded.body;
      options.diagnostics.write('router', 'gptRequestAccepted', {
        requestId,
        route: 'gptGateway',
        modelAlias: model,
        upstreamModel: identity?.upstreamModel ?? null,
        modelDisplayName: identity?.displayName ?? null,
        requestPath: url.pathname,
        requestBytes: bounded.body.length,
      });
      if (identityRewrite) {
        options.diagnostics.write('router', 'gptIdentityPromptApplied', {
          requestId,
          modelAlias: model,
          upstreamModel: identity?.upstreamModel ?? null,
          modelDisplayName: identity?.displayName ?? null,
          identityVersion: GPT_IDENTITY_PROMPT_VERSION,
          systemShape: identityRewrite.systemPromptShape,
          requestBytesBefore: bounded.body.length,
          requestBytesAfter: routedBody.length,
        });
      }
      let credential: string;
      try {
        credential = await readGatewayCredential(options.credentialPath);
      } catch (error: unknown) {
        options.diagnostics.write('router', 'gptCredentialUnavailable', {
          requestId,
          errorCode: routingErrorCode(error),
        });
        sendError(response, 503, 'The local GPT gateway credential is unavailable.');
        return;
      }
      await proxyRequest(
        request,
        response,
        requestPath,
        routedBody,
        options.gptUpstream,
        credential,
        {
          diagnostics: options.diagnostics,
          requestId,
          modelAlias: model,
          upstreamModel: identity?.upstreamModel ?? null,
          modelDisplayName: identity?.displayName ?? null,
          startedAt,
        },
      );
      return;
    }

    await proxyRequest(
      request,
      response,
      requestPath,
      bounded.body,
      options.nativeUpstream,
      null,
    );
  } catch (error: unknown) {
    options.diagnostics.write('router', 'requestFailed', {
      requestId,
      errorCode: routingErrorCode(error),
      headersSent: response.headersSent,
    });
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendError(response, 400, 'The request could not be routed.');
  }
}

function routerEnvironment(
  options: Pick<
    NormalizedRouterOptions,
    'socketPath' | 'stateDirectory' | 'httpPort' | 'readinessToken'
  >,
): Readonly<ClaudeGptTlsRouterEnvironment> {
  const environment: ClaudeGptTlsRouterEnvironment = {
    ANTHROPIC_UNIX_SOCKET: options.socketPath,
    SSL_CERT_FILE: certificatePaths(options.stateDirectory).caCertificate,
    NODE_EXTRA_CA_CERTS: certificatePaths(options.stateDirectory).caCertificate,
  };
  if (options.httpPort !== null) {
    environment.ANTHROPIC_BASE_URL = `http://127.0.0.1:${options.httpPort}${routerHttpPathPrefix(options.readinessToken)}`;
    environment._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = 'true';
  }
  return Object.freeze(environment);
}

function probeRouterReadiness(
  socketPath: string,
  ca: Buffer,
  expectedToken = '',
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise(resolveProbe => {
    const request = httpsRequest({
      socketPath,
      servername: CERTIFICATE_HOSTNAME,
      path: READINESS_PATH,
      method: 'GET',
      ca,
      rejectUnauthorized: true,
      headers: { host: CERTIFICATE_HOSTNAME },
      timeout: timeoutMs,
    }, response => {
      const ready = response.statusCode === 204
        && response.headers['x-attune-router-version'] === ROUTER_PROTOCOL_VERSION
        && (expectedToken
          ? response.headers['x-attune-router-token'] === expectedToken
          : response.headers['x-attune-router-token'] === undefined);
      response.resume();
      response.once('end', () => resolveProbe(ready));
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolveProbe(false));
    request.end();
  });
}

function probeHttpRouterReadiness(
  options: Pick<NormalizedRouterOptions, 'httpPort' | 'readinessToken'>,
  timeoutMs = 500,
): Promise<boolean> {
  if (options.httpPort === null) return Promise.resolve(true);
  return new Promise(resolveProbe => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: options.httpPort,
      path: `${routerHttpPathPrefix(options.readinessToken)}${READINESS_PATH}`,
      method: 'GET',
      timeout: timeoutMs,
    }, response => {
      const ready = response.statusCode === 204
        && response.headers['x-attune-router-version'] === ROUTER_PROTOCOL_VERSION
        && response.headers['x-attune-router-token'] === options.readinessToken;
      response.resume();
      response.once('end', () => resolveProbe(ready));
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolveProbe(false));
    request.end();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function safeRequestPath(rawPath: string | undefined): string {
  const value = rawPath ?? '/';
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('#')
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error('Invalid request path.');
  }
  // Validate without resolving an absolute-form URL or changing query ordering.
  new URL(value, 'https://attune.invalid');
  return value;
}

function routerHttpPathPrefix(readinessToken: string): string {
  return `/.attune/${readinessToken}`;
}

function stripRouterHttpPathPrefix(requestPath: string, prefix: string): string | null {
  if (!prefix) return requestPath;
  if (requestPath !== prefix && !requestPath.startsWith(`${prefix}/`)) return null;
  const stripped = requestPath.slice(prefix.length);
  return stripped || '/';
}

async function readBoundedRequest(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<BoundedRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = request[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) return { kind: 'buffer', body: Buffer.concat(chunks, size) };
    const buffer = Buffer.from(next.value as Uint8Array);
    size += buffer.length;
    chunks.push(buffer);
    if (size > maximumBytes) return { kind: 'overflow', chunks, iterator };
  }
}

function classifyModelOrNative(headers: IncomingHttpHeaders, body: Buffer): string | null {
  if (body.length === 0) return null;
  const contentEncoding = headerText(headers['content-encoding'])?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    return null;
  }

  const contentType = headerText(headers['content-type'])?.toLowerCase() ?? '';
  const advertisedAsJson = /(?:^|[/+])json(?:\s*;|$)/.test(contentType);
  const textBody = body.toString('utf8');
  const firstNonWhitespace = textBody.trimStart()[0];
  const looksLikeJsonObject = firstNonWhitespace === '{';
  if (!advertisedAsJson && !looksLikeJsonObject) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    return null;
  }
  return isRecord(parsed) && typeof parsed.model === 'string' ? parsed.model : null;
}

function gptIdentityInstruction(identity: ClaudeGptModelIdentity): string {
  return [
    GPT_IDENTITY_PROMPT_MARKER,
    `You are ${identity.displayName} (${identity.upstreamModel}), an OpenAI GPT model running inside the Claude Code desktop interface through Attune.`,
    'Claude Code is the host application and tool harness. A Claude-compatible model alias may also be visible to the host. Neither identifies the model generating this response.',
    `When asked which model you are, identify yourself as ${identity.displayName} (${identity.upstreamModel}). Do not claim to be a Claude model.`,
    '</attune_model_identity>',
  ].join('\n');
}

function applyGptIdentityPrompt(
  body: Buffer,
  identity: ClaudeGptModelIdentity,
): { body: Buffer; systemPromptShape: 'missing' | 'string' | 'blocks' | 'alreadyApplied' } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const instruction = gptIdentityInstruction(identity);
  const existingSystem = parsed.system;
  if (typeof existingSystem === 'string') {
    if (existingSystem.includes(GPT_IDENTITY_PROMPT_MARKER)) {
      return { body, systemPromptShape: 'alreadyApplied' };
    }
    parsed.system = existingSystem.length > 0
      ? `${existingSystem}\n\n${instruction}`
      : instruction;
    return { body: Buffer.from(JSON.stringify(parsed)), systemPromptShape: 'string' };
  }
  if (Array.isArray(existingSystem)) {
    const alreadyApplied = existingSystem.some(block => isRecord(block)
      && block.type === 'text'
      && typeof block.text === 'string'
      && block.text.includes(GPT_IDENTITY_PROMPT_MARKER));
    if (alreadyApplied) return { body, systemPromptShape: 'alreadyApplied' };
    parsed.system = [
      ...existingSystem,
      { type: 'text', text: instruction },
    ];
    return { body: Buffer.from(JSON.stringify(parsed)), systemPromptShape: 'blocks' };
  }
  if (existingSystem === undefined || existingSystem === null) {
    parsed.system = instruction;
    return { body: Buffer.from(JSON.stringify(parsed)), systemPromptShape: 'missing' };
  }
  return null;
}

async function readGatewayCredential(path: string): Promise<string> {
  const info = await lstat(path);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.uid !== expectedUid
    || (info.mode & 0o077) !== 0
    || info.size > 16 * 1024
  ) {
    throw new Error('Invalid local gateway credential file.');
  }
  const credential = (await readFile(path, 'utf8')).trim();
  if (!credential || /[\r\n\0]/.test(credential)) {
    throw new Error('Invalid local gateway credential.');
  }
  return credential;
}

async function proxyRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  incomingPath: string,
  body: Buffer,
  upstream: URL,
  gatewayCredential: string | null,
  trace: GptRequestTrace | null = null,
): Promise<void> {
  const headers = buildUpstreamHeaders(incoming.headers, upstream, body.length, gatewayCredential);
  const path = joinUpstreamPath(upstream.pathname, incomingPath);
  const requestOptions: RequestOptions = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || undefined,
    method: incoming.method ?? 'GET',
    path,
    headers,
    ...(upstream.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
  };

  await new Promise<void>(resolveProxy => {
    let settled = false;
    let upstreamRequest: ClientRequest;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveProxy();
    };
    const onUpstreamResponse = (upstreamResponse: IncomingMessage) => {
      const upstreamStatus = upstreamResponse.statusCode ?? 502;
      const mediaType = headerText(upstreamResponse.headers['content-type'])
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase() ?? 'unknown';
      const responseTrace = trace ? createResponseTrace(mediaType) : null;
      trace?.diagnostics.write('router', 'gptUpstreamResponse', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        upstreamModel: trace.upstreamModel,
        modelDisplayName: trace.modelDisplayName,
        upstreamStatus,
        mediaType,
        firstByteMs: Date.now() - trace.startedAt,
      });
      response.writeHead(
        upstreamStatus,
        upstreamResponse.statusMessage ?? undefined,
        buildDownstreamHeaders(upstreamResponse.headers),
      );
      const streaming = responseTrace
        ? pipeline(upstreamResponse, responseTrace.inspector, response)
        : pipeline(upstreamResponse, response);
      void streaming.then(() => {
        if (trace && responseTrace) {
          trace.diagnostics.write('router', 'gptResponseCompleted', {
            requestId: trace.requestId,
            modelAlias: trace.modelAlias,
            upstreamModel: trace.upstreamModel,
            modelDisplayName: trace.modelDisplayName,
            upstreamStatus,
            responseBytes: responseTrace.bytes(),
            durationMs: Date.now() - trace.startedAt,
            streamEvents: responseTrace.events(),
          });
        }
        finish();
      }, (error: unknown) => {
        trace?.diagnostics.write('router', 'gptResponseStreamFailed', {
          requestId: trace.requestId,
          modelAlias: trace.modelAlias,
          upstreamModel: trace.upstreamModel,
          modelDisplayName: trace.modelDisplayName,
          upstreamStatus,
          responseBytes: responseTrace?.bytes() ?? 0,
          durationMs: Date.now() - trace.startedAt,
          errorCode: routingErrorCode(error),
          streamEvents: responseTrace?.events() ?? [],
        });
        response.destroy();
        finish();
      });
    };
    const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    upstreamRequest = transport(requestOptions, onUpstreamResponse);
    upstreamRequest.once('error', (error: Error) => {
      trace?.diagnostics.write('router', 'gptUpstreamFailed', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        upstreamModel: trace.upstreamModel,
        modelDisplayName: trace.modelDisplayName,
        durationMs: Date.now() - trace.startedAt,
        errorCode: routingErrorCode(error),
      });
      if (!response.headersSent) {
        sendError(response, 502, gatewayCredential === null
          ? 'The Anthropic upstream is unavailable.'
          : 'The local GPT gateway is unavailable.');
      } else {
        response.destroy();
      }
      finish();
    });
    incoming.once('aborted', () => {
      trace?.diagnostics.write('router', 'gptClientAborted', {
        requestId: trace.requestId,
        modelAlias: trace.modelAlias,
        upstreamModel: trace.upstreamModel,
        modelDisplayName: trace.modelDisplayName,
        durationMs: Date.now() - trace.startedAt,
      });
      upstreamRequest.destroy();
    });
    response.once('close', () => {
      if (!response.writableEnded) {
        trace?.diagnostics.write('router', 'gptDownstreamClosed', {
          requestId: trace.requestId,
          modelAlias: trace.modelAlias,
          upstreamModel: trace.upstreamModel,
          modelDisplayName: trace.modelDisplayName,
          durationMs: Date.now() - trace.startedAt,
        });
        upstreamRequest.destroy();
      }
    });
    upstreamRequest.end(body);
  });
}

interface GptRequestTrace {
  diagnostics: RoutingDiagnostics;
  requestId: string;
  modelAlias: string;
  upstreamModel: string | null;
  modelDisplayName: string | null;
  startedAt: number;
}

function createResponseTrace(mediaType: string): {
  inspector: Transform;
  bytes(): number;
  events(): string[];
} {
  let byteCount = 0;
  let remainder = '';
  const eventTypes = new Set<string>();
  const inspectLine = (line: string) => {
    if (eventTypes.size >= 32) return;
    const eventName = /^event:\s*([A-Za-z0-9_.-]{1,80})\s*$/.exec(line)?.[1];
    if (eventName) eventTypes.add(eventName);
    if (!line.startsWith('data:')) return;
    const type = /"type"\s*:\s*"([A-Za-z0-9_.-]{1,80})"/.exec(line.slice(0, 2048))?.[1];
    if (type) eventTypes.add(type);
  };
  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.length;
      if (mediaType === 'text/event-stream') {
        const text = remainder + chunk.toString('utf8');
        const lines = text.split(/\r?\n/);
        remainder = (lines.pop() ?? '').slice(-4096);
        for (const line of lines) inspectLine(line);
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (remainder) inspectLine(remainder);
      callback();
    },
  });
  return {
    inspector,
    bytes: () => byteCount,
    events: () => [...eventTypes],
  };
}

function forwardStreamingRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  incomingPath: string,
  upstream: URL,
): void {
  const headers = buildNativeStreamingHeaders(incoming.headers, upstream);
  const requestOptions: RequestOptions = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || undefined,
    method: incoming.method ?? 'GET',
    path: joinUpstreamPath(upstream.pathname, incomingPath),
    headers,
    ...(upstream.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
  };
  const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamRequest = transport(requestOptions, upstreamResponse => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? undefined,
      buildDownstreamHeaders(upstreamResponse.headers),
    );
    void pipeline(upstreamResponse, response).catch(() => response.destroy());
  });
  upstreamRequest.once('error', () => {
    if (!response.headersSent) sendError(response, 502, 'The Anthropic upstream is unavailable.');
    else response.destroy();
  });
  incoming.once('aborted', () => upstreamRequest.destroy());
  response.once('close', () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
  void pipeline(incoming, upstreamRequest).catch(() => upstreamRequest.destroy());
}

function forwardRequestIterator(
  incoming: IncomingMessage,
  response: ServerResponse,
  incomingPath: string,
  upstream: URL,
  chunks: Buffer[],
  iterator: AsyncIterator<unknown>,
): void {
  const headers = buildNativeStreamingHeaders(incoming.headers, upstream);
  delete headers['content-length'];
  const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreamRequest = transport({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || undefined,
    method: incoming.method ?? 'POST',
    path: joinUpstreamPath(upstream.pathname, incomingPath),
    headers,
    ...(upstream.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
  }, upstreamResponse => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage ?? undefined,
      buildDownstreamHeaders(upstreamResponse.headers),
    );
    void pipeline(upstreamResponse, response).catch(() => response.destroy());
  });
  upstreamRequest.once('error', () => {
    if (!response.headersSent) sendError(response, 502, 'The Anthropic upstream is unavailable.');
    else response.destroy();
  });
  incoming.once('aborted', () => upstreamRequest.destroy());
  response.once('close', () => {
    if (!response.writableEnded) upstreamRequest.destroy();
  });
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

function buildNativeStreamingHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
): Record<string, string | string[]> {
  const headers = copyEndToEndHeaders(incoming);
  headers.host = upstream.host;
  return headers;
}

function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
  bodyLength: number,
  gatewayCredential: string | null,
): Record<string, string | string[]> {
  const headers = copyEndToEndHeaders(incoming);
  const hadBodyFraming = incoming['content-length'] !== undefined
    || incoming['transfer-encoding'] !== undefined;
  delete headers.host;
  delete headers['content-length'];
  headers.host = upstream.host;
  if (bodyLength > 0 || hadBodyFraming) headers['content-length'] = String(bodyLength);

  if (gatewayCredential !== null) {
    const allowed: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (GPT_HEADER_ALLOWLIST.has(name)) allowed[name] = value;
    }
    allowed.host = upstream.host;
    if (bodyLength > 0 || hadBodyFraming) allowed['content-length'] = String(bodyLength);
    allowed.authorization = `Bearer ${gatewayCredential}`;
    return allowed;
  }
  return headers;
}

function buildDownstreamHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string | string[]> {
  return copyEndToEndHeaders(incoming);
}

function copyEndToEndHeaders(
  incoming: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const connectionTokens = new Set(
    (headerText(incoming.connection) ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const copied: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const lowerName = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) {
      continue;
    }
    copied[lowerName] = value;
  }
  return copied;
}

function joinUpstreamPath(basePath: string, incomingPath: string): string {
  if (!basePath || basePath === '/') return incomingPath;
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  return `${prefix}${incomingPath}`;
}

function sendError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  const body = Buffer.from(JSON.stringify({
    error: { type: 'attune_router_error', message },
  }));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function headerText(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(',');
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function hasExactRequestHost(host: string | undefined, expectedHost: string): boolean {
  const normalized = host?.toLowerCase();
  const expected = expectedHost.toLowerCase();
  return normalized === expected
    || (expected === CERTIFICATE_HOSTNAME && normalized === `${CERTIFICATE_HOSTNAME}:443`);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function writeWithBackpressure(stream: ClientRequest, chunk: Buffer): Promise<void> {
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
