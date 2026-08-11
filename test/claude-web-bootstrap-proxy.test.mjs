import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectTcp, createServer as createNetServer } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';

import {
  CLAUDE_GPT_MODEL_CATALOG,
  createClaudeWebBootstrapProxyReadinessToken,
  ensureClaudeWebBootstrapProxy,
  waitForClaudeWebBootstrapProxy,
} from '../dist/claude-web-bootstrap-proxy.js';

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NATIVE_MODEL = 'claude-sonnet-4-6';

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function bootstrapPayload(org = ORG_A, overrides = {}) {
  return {
    account: { uuid: ACCOUNT, name: 'Native account' },
    resolved_org_uuid: org,
    model_selector_config: [{
      id: 'code',
      label: 'Code',
      models: [{ id: NATIVE_MODEL, name: 'Claude Sonnet 4.6', recommended: true }],
    }],
    model_selector_state: [{
      id: 'code',
      model: NATIVE_MODEL,
      source: 'default',
      preset_key: 'native-preset',
      thinking: { type: 'effort', effort: 'high' },
      thinking_by_model: { [NATIVE_MODEL]: { type: 'effort', effort: 'high' } },
      org_enforced_default_model: null,
    }],
    native_marker: 'unchanged',
    ...overrides,
  };
}

async function createFixture(t, handler, upgradeHandler) {
  const root = await mkdtemp('/tmp/attune-claude-web-proxy-');
  const requests = [];
  const upstreamSockets = new Set();
  const upstream = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const record = { request, body };
      requests.push(record);
      await handler(record, response);
    })().catch(() => response.destroy());
  });
  upstream.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  if (upgradeHandler) upstream.on('upgrade', upgradeHandler);
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === 'object');
  const readinessToken = createClaudeWebBootstrapProxyReadinessToken();
  const options = {
    stateDirectory: join(root, 'state'),
    readinessToken,
    targetUpstream: `http://127.0.0.1:${address.port}`,
    allowInsecureTargetUpstream: true,
  };
  let handle = await ensureClaudeWebBootstrapProxy(options);
  t.after(async () => {
    await handle?.cleanup();
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    requests,
    options,
    get handle() { return handle; },
    set handle(value) { handle = value; },
  };
}

function respondJson(response, value, { status = 200, encoding, extraHeaders = {} } = {}) {
  const plain = Buffer.from(JSON.stringify(value));
  const body = encoding === 'gzip'
    ? gzipSync(plain)
    : encoding === 'deflate'
      ? deflateSync(plain)
      : encoding === 'br'
        ? brotliCompressSync(plain)
        : plain;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...(encoding ? { 'content-encoding': encoding } : {}),
    ...extraHeaders,
  });
  response.end(body);
}

async function openTunnel(proxyPort, authority = 'claude.ai:443', proxyAuthorization = null) {
  const socket = connectTcp(proxyPort, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write([
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    ...(proxyAuthorization ? [`Proxy-Authorization: ${proxyAuthorization}`] : []),
    '',
    '',
  ].join('\r\n'));
  const header = await new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.off('data', onData);
      const rest = buffered.subarray(boundary + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffered.subarray(0, boundary + 4).toString());
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  return { socket, header };
}

async function requestThroughProxy(handle, {
  method = 'GET',
  path = '/api/bootstrap',
  headers = {},
  body = Buffer.alloc(0),
} = {}) {
  const tunnel = await openTunnel(handle.port);
  assert.match(tunnel.header, /^HTTP\/1\.1 200 /);
  const secureSocket = connectTls({
    socket: tunnel.socket,
    servername: 'claude.ai',
    rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const outgoingHeaders = {
    host: 'claude.ai',
    connection: 'close',
    ...(payload.length ? { 'content-length': String(payload.length) } : {}),
    ...headers,
  };
  const head = [
    `${method} ${path} HTTP/1.1`,
    ...Object.entries(outgoingHeaders).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    secureSocket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    secureSocket.once('end', () => resolve(Buffer.concat(chunks)));
    secureSocket.once('error', reject);
    secureSocket.write(Buffer.concat([Buffer.from(head), payload]));
  });
  const boundary = raw.indexOf('\r\n\r\n');
  assert.ok(boundary >= 0, 'proxy response must include HTTP headers');
  const headerLines = raw.subarray(0, boundary).toString().split('\r\n');
  const statusCode = Number(/^HTTP\/1\.1\s+(\d+)/.exec(headerLines.shift())?.[1]);
  const responseHeaders = {};
  for (const line of headerLines) {
    const separator = line.indexOf(':');
    if (separator > 0) responseHeaders[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  let responseBody = raw.subarray(boundary + 4);
  if (responseHeaders['transfer-encoding']?.toLowerCase() === 'chunked') {
    responseBody = decodeChunked(responseBody);
  }
  return { statusCode, headers: responseHeaders, body: responseBody };
}

function decodeChunked(raw) {
  const chunks = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString().split(';', 1)[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    chunks.push(raw.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(chunks);
}

async function getHttp(port, path, headers = {}) {
  return await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, response => {
      void readBody(response).then(body => resolve({ statusCode: response.statusCode, body }), reject);
    });
    request.once('error', reject);
    request.end();
  });
}

test('publishes a host-selective PAC, stable SPKI, and token-bound readiness', async t => {
  const fixture = await createFixture(t, (_record, response) => respondJson(response, {}));
  const ready = await waitForClaudeWebBootstrapProxy(fixture.options, 2_000);
  assert.deepEqual(ready, fixture.handle.launchConfiguration);
  assert.equal(await fixture.handle.health(), true);
  const pac = await getHttp(fixture.handle.port, '/proxy.pac');
  assert.equal(pac.statusCode, 200);
  assert.match(pac.body.toString(), /claude\.ai/);
  assert.match(pac.body.toString(), /DIRECT/);
  assert.doesNotMatch(pac.body.toString(), /api\.anthropic\.com/);
  const rejected = await openTunnel(fixture.handle.port, 'example.com:443');
  assert.match(rejected.header, /^HTTP\/1\.1 403 /);
  rejected.socket.destroy();

  const certificate = new X509Certificate(await readFile(join(fixture.options.stateDirectory, 'claude.ai.pem')));
  const spki = createHash('sha256').update(
    certificate.publicKey.export({ type: 'spki', format: 'der' }),
  ).digest('base64');
  assert.equal(spki, fixture.handle.spkiHash);
  const originalSpki = fixture.handle.spkiHash;
  await fixture.handle.cleanup();
  fixture.options.readinessToken = createClaudeWebBootstrapProxyReadinessToken();
  fixture.handle = await ensureClaudeWebBootstrapProxy(fixture.options);
  assert.equal(fixture.handle.spkiHash, originalSpki);
});

test('authenticates Claude Code CONNECTs and tunnels Anthropic API traffic to the router UDS', async t => {
  const fixture = await createFixture(t, (_record, response) => respondJson(response, {}));
  const socketPath = join(fixture.root, 'anthropic-router.sock');
  const apiServer = createNetServer(socket => {
    socket.once('data', chunk => socket.write(`router:${chunk.toString()}`));
  });
  await new Promise((resolveListen, rejectListen) => {
    apiServer.once('error', rejectListen);
    apiServer.listen(socketPath, resolveListen);
  });
  let apiServerClosed = false;
  const closeApiServer = async () => {
    if (apiServerClosed) return;
    apiServerClosed = true;
    await new Promise(resolveClose => apiServer.close(resolveClose));
  };
  t.after(() => closeApiServer());

  await fixture.handle.cleanup();
  const accessToken = createClaudeWebBootstrapProxyReadinessToken();
  fixture.options.readinessToken = createClaudeWebBootstrapProxyReadinessToken();
  fixture.options.anthropicSocketPath = socketPath;
  fixture.options.proxyAccessToken = accessToken;
  fixture.options.diagnosticsPath = join(fixture.root, 'logs', 'routing.jsonl');
  fixture.handle = await ensureClaudeWebBootstrapProxy(fixture.options);

  const rejected = await openTunnel(fixture.handle.port, 'api.anthropic.com:443');
  assert.match(rejected.header, /^HTTP\/1\.1 407 /);
  rejected.socket.destroy();

  const proxyAuthorization = `Basic ${Buffer.from(`attune:${accessToken}`).toString('base64')}`;
  const accepted = await openTunnel(
    fixture.handle.port,
    'api.anthropic.com:443',
    proxyAuthorization,
  );
  assert.match(accepted.header, /^HTTP\/1\.1 200 /);
  const response = withTimeout(new Promise((resolve, reject) => {
    accepted.socket.once('data', chunk => resolve(chunk.toString()));
    accepted.socket.once('error', reject);
  }), 2_000, 'Anthropic router tunnel');
  accepted.socket.write('probe');
  assert.equal(await response, 'router:probe');
  accepted.socket.destroy();
  await closeApiServer();
  await fixture.handle.cleanup();

  const rawDiagnostics = await readFile(fixture.options.diagnosticsPath, 'utf8');
  const records = rawDiagnostics.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.some(record => record.event === 'connectRejected'
    && record.authorityClass === 'anthropicApi'
    && record.status === 407));
  const established = records.find(record => record.event === 'connectEstablished'
    && record.authorityClass === 'anthropicApi');
  assert.equal(established?.route, 'gptRouter');
  assert.doesNotMatch(rawDiagnostics, new RegExp(accessToken));
});

test('augments both bootstrap families while preserving native models and unrelated traffic', async t => {
  const fixture = await createFixture(t, ({ request, body }, response) => {
    if (request.url.includes('app_start') || request.url.endsWith('/bootstrap')) {
      respondJson(response, bootstrapPayload());
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-native-auth': request.headers.authorization ?? 'missing',
    });
    response.write('data: native-one\n\n');
    setImmediate(() => response.end(`data: native-two:${body.toString()}\n\n`));
  });

  for (const path of [
    '/api/bootstrap',
    `/edge-api/bootstrap/${ORG_A.toUpperCase()}/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk`,
    `/api/bootstrap/${ORG_A}/app_start?include_system_prompts=false`,
  ]) {
    const result = await requestThroughProxy(fixture.handle, { path });
    assert.equal(result.statusCode, 200);
    const payload = JSON.parse(result.body.toString());
    assert.equal(payload.native_marker, 'unchanged');
    const code = payload.model_selector_config.find(entry => entry.id === 'code');
    assert.deepEqual(code.models.slice(0, 1), bootstrapPayload().model_selector_config[0].models);
    assert.deepEqual(
      code.models.slice(1).map(({ id, name }) => ({ id, name })),
      CLAUDE_GPT_MODEL_CATALOG.map(({ id, name }) => ({ id, name })),
    );
  }

  const native = await requestThroughProxy(fixture.handle, {
    method: 'POST',
    path: `/api/organizations/${ORG_A}/conversations?limit=5`,
    headers: {
      authorization: 'Bearer native-oauth',
      cookie: 'session=native',
      'content-type': 'application/octet-stream',
    },
    body: 'native-body',
  });
  assert.equal(native.body.toString(), 'data: native-one\n\ndata: native-two:native-body\n\n');
  const upstreamNative = fixture.requests.at(-1);
  assert.equal(upstreamNative.request.headers.authorization, 'Bearer native-oauth');
  assert.equal(upstreamNative.request.headers.cookie, 'session=native');
  assert.equal(upstreamNative.body.toString(), 'native-body');

  const wrongHost = await requestThroughProxy(fixture.handle, {
    headers: { host: 'localhost' },
  });
  assert.equal(wrongHost.statusCode, 421);
});

test('stores an alias selection, overlays it on reload, and clears it only after native success', async t => {
  let nativeSelectionStatus = 200;
  const fixture = await createFixture(t, ({ request }, response) => {
    if (request.url.includes('app_start')) respondJson(response, bootstrapPayload());
    else respondJson(response, { native: true }, { status: nativeSelectionStatus });
  });
  const bootstrapPath = `/api/bootstrap/${ORG_A}/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk`;
  const selectionPath = `/edge-api/organizations/${ORG_A}/model_selector_state/code`;
  await requestThroughProxy(fixture.handle, { path: bootstrapPath });
  const alias = CLAUDE_GPT_MODEL_CATALOG[1].id;
  const selected = await requestThroughProxy(fixture.handle, {
    method: 'PATCH',
    path: selectionPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: alias, thinking: null }),
  });
  assert.deepEqual(JSON.parse(selected.body.toString()), {
    thinking: null,
    thinking_by_model: null,
    id: 'code',
    model: alias,
    source: 'user_setting',
  });
  assert.equal(fixture.requests.filter(({ request }) => request.url === selectionPath).length, 0);

  const reloaded = JSON.parse((await requestThroughProxy(fixture.handle, { path: bootstrapPath })).body);
  const state = reloaded.model_selector_state.find(entry => entry.id === 'code');
  assert.equal(state.model, alias);
  assert.equal(state.source, 'user_setting');
  assert.equal(state.preset_key, null);
  assert.equal(state.thinking, null);
  assert.deepEqual(state.thinking_by_model, bootstrapPayload().model_selector_state[0].thinking_by_model);

  nativeSelectionStatus = 500;
  await requestThroughProxy(fixture.handle, {
    method: 'PATCH', path: selectionPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: NATIVE_MODEL }),
  });
  assert.equal(
    JSON.parse((await requestThroughProxy(fixture.handle, { path: bootstrapPath })).body)
      .model_selector_state[0].model,
    alias,
  );
  nativeSelectionStatus = 200;
  await requestThroughProxy(fixture.handle, {
    method: 'PATCH', path: selectionPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: NATIVE_MODEL }),
  });
  assert.equal(
    JSON.parse((await requestThroughProxy(fixture.handle, { path: bootstrapPath })).body)
      .model_selector_state[0].model,
    NATIVE_MODEL,
  );
});

test('decodes supported bootstrap compression and leaves non-200 responses untouched', async t => {
  let responseMode = 'gzip';
  const fixture = await createFixture(t, (_record, response) => {
    if (responseMode === 'non-200') {
      respondJson(response, { native_error: true }, {
        status: 206,
        extraHeaders: { etag: 'native-etag' },
      });
      return;
    }
    respondJson(response, bootstrapPayload(), { encoding: responseMode });
  });
  for (const encoding of ['gzip', 'deflate', 'br']) {
    responseMode = encoding;
    const result = await requestThroughProxy(fixture.handle, { path: `/api/bootstrap/${ORG_A}/app_start` });
    assert.equal(result.headers['content-encoding'], undefined);
    assert.equal(JSON.parse(result.body).model_selector_config[0].models.length, 4);
  }
  responseMode = 'non-200';
  const partial = await requestThroughProxy(fixture.handle, { path: `/api/bootstrap/${ORG_A}/app_start` });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers.etag, 'native-etag');
  assert.deepEqual(JSON.parse(partial.body), { native_error: true });
});

test('an enforced native default suppresses aliases and clears a stored GPT choice', async t => {
  let enforced = false;
  const fixture = await createFixture(t, ({ request }, response) => {
    if (request.url.includes('app_start')) {
      const payload = bootstrapPayload();
      if (enforced) payload.model_selector_state[0].org_enforced_default_model = NATIVE_MODEL;
      respondJson(response, payload);
    } else respondJson(response, { native: true });
  });
  const bootstrapPath = `/api/bootstrap/${ORG_A}/app_start`;
  const selectionPath = `/api/organizations/${ORG_A}/model_selector_state/code`;
  await requestThroughProxy(fixture.handle, { path: bootstrapPath });
  await requestThroughProxy(fixture.handle, {
    method: 'PATCH', path: selectionPath,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CLAUDE_GPT_MODEL_CATALOG[0].id }),
  });
  enforced = true;
  const result = JSON.parse((await requestThroughProxy(fixture.handle, { path: bootstrapPath })).body);
  assert.equal(result.model_selector_config[0].models.length, 1);
  assert.equal(result.model_selector_state[0].model, NATIVE_MODEL);
});

test('concurrent bootstraps for different organizations do not invalidate one another', async t => {
  let releaseA;
  let releaseB;
  let arrivedA;
  let arrivedB;
  const allowA = new Promise(resolve => { releaseA = resolve; });
  const allowB = new Promise(resolve => { releaseB = resolve; });
  const sawA = new Promise(resolve => { arrivedA = resolve; });
  const sawB = new Promise(resolve => { arrivedB = resolve; });
  const fixture = await createFixture(t, async ({ request }, response) => {
    if (request.url.includes(ORG_A)) {
      arrivedA();
      await allowA;
      respondJson(response, bootstrapPayload(ORG_A));
      return;
    }
    arrivedB();
    await allowB;
    respondJson(response, bootstrapPayload(ORG_B));
  });
  const requestA = requestThroughProxy(fixture.handle, {
    path: `/api/bootstrap/${ORG_A}/app_start`,
  });
  await sawA;
  const requestB = requestThroughProxy(fixture.handle, {
    path: `/edge-api/bootstrap/${ORG_B}/app_start`,
  });
  await sawB;
  releaseB();
  const responseB = await requestB;
  releaseA();
  const responseA = await requestA;
  assert.equal(JSON.parse(responseA.body).model_selector_config[0].models.length, 4);
  assert.equal(JSON.parse(responseB.body).model_selector_config[0].models.length, 4);
});

test('passes WebSocket upgrades through and closes both sides cleanly', async t => {
  const fixture = await createFixture(
    t,
    (_record, response) => respondJson(response, {}),
    (request, socket, head) => {
      assert.equal(request.url, '/socket');
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'));
      if (head.length > 0) socket.write(head);
      socket.on('data', chunk => socket.write(chunk));
    },
  );
  const tunnel = await openTunnel(fixture.handle.port);
  const secureSocket = connectTls({
    socket: tunnel.socket,
    servername: 'claude.ai',
    rejectUnauthorized: false,
  });
  await new Promise((resolve, reject) => {
    secureSocket.once('secureConnect', resolve);
    secureSocket.once('error', reject);
  });
  secureSocket.write([
    'GET /socket HTTP/1.1',
    'Host: claude.ai',
    'Connection: Upgrade',
    'Upgrade: websocket',
    '',
    '',
  ].join('\r\n'));
  const upgradeHead = await withTimeout(new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = chunk => {
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (!data.includes('\r\n\r\n')) return;
      secureSocket.off('data', onData);
      resolve(data.toString());
    };
    secureSocket.on('data', onData);
    secureSocket.once('error', reject);
  }), 2_000, 'WebSocket upgrade response');
  assert.match(upgradeHead, /^HTTP\/1\.1 101 /);
  const echo = withTimeout(new Promise((resolve, reject) => {
    secureSocket.once('data', chunk => resolve(chunk.toString()));
    secureSocket.once('error', reject);
  }), 2_000, 'WebSocket echo');
  secureSocket.write('attune-websocket-echo');
  assert.equal(await echo, 'attune-websocket-echo');
  secureSocket.destroy();
  await fixture.handle.cleanup();
  assert.equal(fixture.handle.status().running, false);
});

function withTimeout(promise, milliseconds, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    timer.unref();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test('rejects broad state paths and non-exact production target origins', async () => {
  await assert.rejects(ensureClaudeWebBootstrapProxy({ stateDirectory: '/' }), /too broad/);
  assert.throws(
    () => ensureClaudeWebBootstrapProxy({ targetUpstream: 'https://example.com' }),
    /must be exact/,
  );
});
