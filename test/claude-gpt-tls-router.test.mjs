import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  CLAUDE_GPT_MODEL_ALIASES,
  createClaudeGptTlsRouterReadinessToken,
  ensureClaudeGptTlsRouter,
  getClaudeGptTlsRouterEnvironment,
  waitForClaudeGptTlsRouter,
} from '../dist/claude-gpt-tls-router.js';

const TLS_HOSTNAME = 'api.anthropic.com';

function assertIdentityPrompt(text, displayName, upstreamModel) {
  assert.match(text, /<attune_model_identity version="1">/);
  assert.match(text, new RegExp(`You are ${displayName.replace('.', '\\.')} \\(${upstreamModel.replaceAll('.', '\\.')}\\)`));
  assert.match(text, new RegExp(`identify yourself as ${displayName.replace('.', '\\.')}`));
  assert.match(text, /Do not claim to be a Claude model/);
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function startMockUpstream(name) {
  const requests = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-mock-upstream': name,
      });
      response.write(`data: ${name}-one\n\n`);
      setImmediate(() => response.end(`data: ${name}-two\n\n`));
    })().catch(() => response.destroy());
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function createFixture(t, {
  withCredential = true,
  withDiagnostics = false,
  maxRequestBodyBytes,
  withHttpBase = false,
} = {}) {
  const root = await mkdtemp('/tmp/attune-claude-router-test-');
  const stateDirectory = join(root, 'state');
  const credentialDirectory = join(root, 'credentials');
  const credentialPath = join(credentialDirectory, 'client.key');
  await mkdir(credentialDirectory, { mode: 0o700 });
  if (withCredential) {
    await writeFile(credentialPath, 'test-local-gateway-key\n', { mode: 0o600 });
  }

  const native = await startMockUpstream('native');
  const gpt = await startMockUpstream('gpt');
  const options = {
    stateDirectory,
    credentialPath,
    nativeUpstream: native.url,
    gptUpstream: gpt.url,
    allowInsecureNativeUpstream: true,
    ...(withDiagnostics ? { diagnosticsPath: join(root, 'logs', 'routing.jsonl') } : {}),
    ...(withHttpBase ? {
      httpPort: await getAvailablePort(),
      readinessToken: createClaudeGptTlsRouterReadinessToken(),
    } : {}),
    ...(maxRequestBodyBytes ? { maxRequestBodyBytes } : {}),
  };
  let handle = null;
  t.after(async () => {
    await handle?.cleanup();
    await Promise.all([native.close(), gpt.close()]);
    await rm(root, { recursive: true, force: true });
  });
  handle = await ensureClaudeGptTlsRouter(options);
  return { root, stateDirectory, credentialPath, native, gpt, options, handle };
}

async function requestHttpRouter(handle, {
  body = '',
  headers = {},
  method = 'POST',
  path = '/v1/messages',
  includeRouteToken = true,
} = {}) {
  assert.ok(handle.httpPort);
  const routeBase = includeRouteToken
    ? handle.env.ANTHROPIC_BASE_URL
    : `http://127.0.0.1:${handle.httpPort}`;
  assert.ok(routeBase);
  const url = new URL(`${routeBase}${path}`);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, { method, headers }, response => {
      void readBody(response).then(responseBody => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }), rejectRequest);
    });
    request.once('error', rejectRequest);
    request.end(body);
  });
}

async function requestRouter(handle, { body = '', headers = {}, method = 'POST', path = '/v1/messages' } = {}) {
  const ca = await readFile(handle.caCertificatePath);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest({
      socketPath: handle.socketPath,
      servername: TLS_HOSTNAME,
      ca,
      rejectUnauthorized: true,
      method,
      path,
      headers: {
        host: TLS_HOSTNAME,
        ...headers,
      },
    }, response => {
      void readBody(response).then(responseBody => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }), rejectRequest);
    });
    request.once('error', rejectRequest);
    request.end(body);
  });
}

test('correlates a GPT stream without logging request or response content', async t => {
  const fixture = await createFixture(t, { withDiagnostics: true });
  const privatePrompt = 'diagnostic-private-prompt-never-log';
  const privateAuthorization = 'Bearer diagnostic-private-auth-never-log';
  const response = await requestRouter(fixture.handle, {
    body: JSON.stringify({
      model: CLAUDE_GPT_MODEL_ALIASES[0],
      messages: [{ role: 'user', content: privatePrompt }],
    }),
    headers: {
      'content-type': 'application/json',
      authorization: privateAuthorization,
    },
  });
  assert.equal(response.statusCode, 200);
  await fixture.handle.cleanup();

  const raw = await readFile(fixture.options.diagnosticsPath, 'utf8');
  const records = raw.trim().split('\n').map(line => JSON.parse(line));
  const accepted = records.find(record => record.event === 'gptRequestAccepted');
  const upstream = records.find(record => record.event === 'gptUpstreamResponse');
  const completed = records.find(record => record.event === 'gptResponseCompleted');
  assert.ok(accepted?.requestId);
  assert.equal(upstream?.requestId, accepted.requestId);
  assert.equal(completed?.requestId, accepted.requestId);
  assert.equal(completed?.upstreamStatus, 200);
  assert.ok(completed?.responseBytes > 0);
  assert.doesNotMatch(raw, /diagnostic-private-prompt|diagnostic-private-auth/);
});

test('selectively routes only exact GPT aliases and preserves native Claude traffic', async t => {
  const fixture = await createFixture(t);
  const { handle, native, gpt } = fixture;

  const nativePayload = Buffer.from(JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'native request' }],
  }));
  const nativeResponse = await requestRouter(handle, {
    body: nativePayload,
    path: '/v1/messages?beta=one&beta=two',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer native-oauth-token',
      'x-api-key': 'native-api-key',
      'anthropic-version': '2023-06-01',
    },
  });
  assert.equal(nativeResponse.statusCode, 200);
  assert.equal(nativeResponse.headers['x-mock-upstream'], 'native');
  assert.equal(nativeResponse.body.toString(), 'data: native-one\n\ndata: native-two\n\n');
  assert.equal(native.requests.length, 1);
  assert.equal(gpt.requests.length, 0);
  assert.equal(native.requests[0].url, '/v1/messages?beta=one&beta=two');
  assert.equal(native.requests[0].headers.authorization, 'Bearer native-oauth-token');
  assert.equal(native.requests[0].headers['x-api-key'], 'native-api-key');
  assert.equal(native.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(native.requests[0].body, nativePayload);

  const gptPayload = Buffer.from(JSON.stringify({
    model: CLAUDE_GPT_MODEL_ALIASES[0],
    stream: true,
    messages: [{ role: 'user', content: 'gpt request' }],
  }));
  const gptResponse = await requestRouter(handle, {
    body: gptPayload,
    path: '/v1/messages?stream=true',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: 'Bearer must-not-leak',
      'x-api-key': 'must-not-leak-either',
      'x-anthropic-api-key': 'also-private',
    },
  });
  assert.equal(gptResponse.statusCode, 200);
  assert.equal(gptResponse.headers['x-mock-upstream'], 'gpt');
  assert.equal(gptResponse.body.toString(), 'data: gpt-one\n\ndata: gpt-two\n\n');
  assert.equal(native.requests.length, 1);
  assert.equal(gpt.requests.length, 1);
  assert.equal(gpt.requests[0].url, '/v1/messages?stream=true');
  assert.equal(gpt.requests[0].headers.authorization, 'Bearer test-local-gateway-key');
  assert.equal(gpt.requests[0].headers['x-api-key'], undefined);
  assert.equal(gpt.requests[0].headers['x-anthropic-api-key'], undefined);
  assert.equal(gpt.requests[0].headers.cookie, undefined);
  assert.equal(gpt.requests[0].headers['anthropic-user-profile-id'], undefined);
  const routedGptPayload = JSON.parse(gpt.requests[0].body.toString('utf8'));
  assert.equal(routedGptPayload.model, CLAUDE_GPT_MODEL_ALIASES[0]);
  assert.equal(routedGptPayload.stream, true);
  assert.deepEqual(routedGptPayload.messages, [{ role: 'user', content: 'gpt request' }]);
  assertIdentityPrompt(routedGptPayload.system, 'GPT-5.6 Sol', 'gpt-5.6-sol');

  await requestRouter(handle, {
    body: JSON.stringify({ model: `${CLAUDE_GPT_MODEL_ALIASES[0]}-not-exact` }),
    headers: { 'content-type': 'application/json', authorization: 'Bearer still-native' },
  });
  assert.equal(native.requests.length, 2);
  assert.equal(gpt.requests.length, 1);
  assert.equal(native.requests[1].headers.authorization, 'Bearer still-native');
});

test('adds the actual GPT identity without replacing Claude Code harness instructions', async t => {
  const fixture = await createFixture(t, { withDiagnostics: true });
  const cases = [
    {
      alias: CLAUDE_GPT_MODEL_ALIASES[0],
      displayName: 'GPT-5.6 Sol',
      upstreamModel: 'gpt-5.6-sol',
      expectedShape: 'missing',
    },
    {
      alias: CLAUDE_GPT_MODEL_ALIASES[1],
      displayName: 'GPT-5.6 Terra',
      upstreamModel: 'gpt-5.6-terra',
      system: 'existing Claude Code harness instruction',
      expectedShape: 'string',
    },
    {
      alias: CLAUDE_GPT_MODEL_ALIASES[2],
      displayName: 'GPT-5.6 Luna',
      upstreamModel: 'gpt-5.6-luna',
      system: [{
        type: 'text',
        text: 'existing cached Claude Code harness block',
        cache_control: { type: 'ephemeral' },
      }],
      expectedShape: 'blocks',
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const payload = {
      model: testCase.alias,
      messages: [{ role: 'user', content: `identity case ${index}` }],
      ...(testCase.system === undefined ? {} : { system: testCase.system }),
    };
    const response = await requestRouter(fixture.handle, {
      body: JSON.stringify(payload),
      path: index === 2 ? '/v1/messages/count_tokens' : '/v1/messages',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(response.statusCode, 200);

    const routed = JSON.parse(fixture.gpt.requests[index].body.toString('utf8'));
    assert.equal(routed.model, payload.model);
    assert.deepEqual(routed.messages, payload.messages);
    if (typeof testCase.system === 'string') {
      assert.ok(routed.system.startsWith(`${testCase.system}\n\n`));
      assertIdentityPrompt(routed.system, testCase.displayName, testCase.upstreamModel);
    } else if (Array.isArray(testCase.system)) {
      assert.deepEqual(routed.system[0], testCase.system[0]);
      assert.equal(routed.system.length, 2);
      assert.deepEqual(Object.keys(routed.system[1]).sort(), ['text', 'type']);
      assert.equal(routed.system[1].type, 'text');
      assertIdentityPrompt(routed.system[1].text, testCase.displayName, testCase.upstreamModel);
    } else {
      assert.equal(typeof routed.system, 'string');
      assertIdentityPrompt(routed.system, testCase.displayName, testCase.upstreamModel);
    }
  }

  await fixture.handle.cleanup();
  const diagnostics = (await readFile(fixture.options.diagnosticsPath, 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const applied = diagnostics.filter(record => record.event === 'gptIdentityPromptApplied');
  assert.equal(applied.length, cases.length);
  for (const [index, record] of applied.entries()) {
    assert.equal(record.modelAlias, cases[index].alias);
    assert.equal(record.modelDisplayName, cases[index].displayName);
    assert.equal(record.upstreamModel, cases[index].upstreamModel);
    assert.equal(record.identityVersion, '1');
    assert.equal(record.systemShape, cases[index].expectedShape);
    assert.ok(record.requestBytesAfter > record.requestBytesBefore);
  }
});

test('authenticated loopback base URL routes current Claude Code builds selectively', async t => {
  const fixture = await createFixture(t, { withHttpBase: true, withDiagnostics: true });
  const { handle, native, gpt } = fixture;
  assert.equal(handle.httpPort, fixture.options.httpPort);
  assert.equal(handle.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, 'true');
  assert.match(
    handle.env.ANTHROPIC_BASE_URL,
    new RegExp(`^http://127\\.0\\.0\\.1:${handle.httpPort}/\\.attune/[A-Za-z0-9_-]{16,128}$`),
  );

  const gptPayload = JSON.stringify({
    model: CLAUDE_GPT_MODEL_ALIASES[1],
    messages: [{ role: 'user', content: 'loopback gpt request' }],
  });
  const gptResponse = await requestHttpRouter(handle, {
    body: gptPayload,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer native-must-not-leak',
    },
  });
  assert.equal(gptResponse.statusCode, 200);
  assert.equal(gptResponse.headers['x-mock-upstream'], 'gpt');
  assert.equal(gpt.requests.length, 1);
  assert.equal(gpt.requests[0].url, '/v1/messages');
  assert.equal(gpt.requests[0].headers.authorization, 'Bearer test-local-gateway-key');

  const nativeResponse = await requestHttpRouter(handle, {
    body: JSON.stringify({
      model: 'claude-sonnet-4-8',
      messages: [{ role: 'user', content: 'loopback native request' }],
    }),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer native-oauth-token',
    },
  });
  assert.equal(nativeResponse.statusCode, 200);
  assert.equal(nativeResponse.headers['x-mock-upstream'], 'native');
  assert.equal(native.requests.length, 1);
  assert.equal(native.requests[0].url, '/v1/messages');
  assert.equal(native.requests[0].headers.authorization, 'Bearer native-oauth-token');

  const helloResponse = await requestHttpRouter(handle, {
    method: 'HEAD',
    path: '/api/hello',
  });
  assert.equal(helloResponse.statusCode, 200);
  assert.equal(native.requests.length, 2);
  assert.equal(native.requests[1].url, '/api/hello');

  const rejected = await requestHttpRouter(handle, {
    body: gptPayload,
    headers: { 'content-type': 'application/json' },
    includeRouteToken: false,
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(gpt.requests.length, 1);

  await handle.cleanup();
  const diagnosticText = await readFile(fixture.options.diagnosticsPath, 'utf8');
  const diagnostics = diagnosticText.trim().split('\n').map(line => JSON.parse(line));
  const classified = diagnostics.find(record => record.event === 'messageRouteClassified'
    && record.route === 'gptGateway');
  assert.ok(classified?.requestId);
  assert.equal(classified.transport, 'httpLoopback');
  assert.ok(diagnostics.some(record => record.event === 'messageRequestReceived'
    && record.requestId === classified.requestId
    && record.transport === 'httpLoopback'));
  assert.ok(diagnostics.some(record => record.event === 'gptResponseCompleted'
    && record.requestId === classified.requestId));
});

test('exposes deterministic launch env and a TLS readiness handshake without mutating process.env', async t => {
  const root = await mkdtemp('/tmp/attune-claude-router-ready-');
  const stateDirectory = join(root, 'state');
  const readinessToken = createClaudeGptTlsRouterReadinessToken();
  const options = { stateDirectory, readinessToken };
  assert.match(readinessToken, /^[A-Za-z0-9_-]{16,128}$/);
  const environmentBefore = { ...process.env };
  const expected = getClaudeGptTlsRouterEnvironment(options);
  assert.equal(expected.ANTHROPIC_UNIX_SOCKET, join(stateDirectory, 'api.anthropic.com.sock'));
  assert.equal(expected.SSL_CERT_FILE, join(stateDirectory, 'attune-router-ca.pem'));
  assert.equal(expected.NODE_EXTRA_CA_CERTS, join(stateDirectory, 'attune-router-ca.pem'));
  assert.equal(expected.ANTHROPIC_BASE_URL, undefined);
  assert.equal(expected._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, undefined);
  assert.deepEqual({ ...process.env }, environmentBefore);

  await assert.rejects(
    waitForClaudeGptTlsRouter(options, 75),
    /did not become ready/,
  );

  const native = await startMockUpstream('native');
  const gpt = await startMockUpstream('gpt');
  const routerOptions = {
    ...options,
    nativeUpstream: native.url,
    gptUpstream: gpt.url,
    allowInsecureNativeUpstream: true,
  };
  const handle = await ensureClaudeGptTlsRouter(routerOptions);
  t.after(async () => {
    await handle.cleanup();
    await Promise.all([native.close(), gpt.close()]);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    waitForClaudeGptTlsRouter({
      ...routerOptions,
      readinessToken: createClaudeGptTlsRouterReadinessToken(),
    }, 75),
    /did not become ready/,
  );
  const ready = await waitForClaudeGptTlsRouter(routerOptions, 2_000);
  assert.deepEqual(ready, expected);
  assert.deepEqual(handle.env, expected);
  assert.deepEqual({ ...process.env }, environmentBefore);
  assert.equal(handle.status().running, true);
  assert.equal(await handle.health(), true);

  assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(handle.socketPath)).mode & 0o777, 0o600);
  for (const file of [
    'attune-router-ca-key.pem',
    'attune-router-ca.pem',
    'api.anthropic.com-key.pem',
    'api.anthropic.com.pem',
  ]) {
    assert.equal((await stat(join(stateDirectory, file))).mode & 0o777, 0o600);
  }

  await handle.cleanup();
  assert.equal(handle.status().running, false);
  await assert.rejects(access(handle.socketPath), { code: 'ENOENT' });
});

test('a new watcher waits for the old UDS owner and readiness rejects the old generation', async t => {
  const root = await mkdtemp('/tmp/attune-claude-router-takeover-');
  const stateDirectory = join(root, 'state');
  const oldOptions = {
    stateDirectory,
    readinessToken: createClaudeGptTlsRouterReadinessToken(),
  };
  const routerModuleUrl = new URL('../dist/claude-gpt-tls-router.js', import.meta.url).href;
  const childScript = `
    import { ensureClaudeGptTlsRouter } from ${JSON.stringify(routerModuleUrl)};
    const options = JSON.parse(process.env.ATTUNE_ROUTER_TEST_OPTIONS);
    const handle = await ensureClaudeGptTlsRouter(options);
    process.send?.('ready');
    let stopping = false;
    process.on('SIGTERM', () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => void handle.cleanup().finally(() => process.exit(0)), 150);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: {
      ...process.env,
      ATTUNE_ROUTER_TEST_OPTIONS: JSON.stringify(oldOptions),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let replacement = null;
  t.after(async () => {
    await replacement?.cleanup();
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Old router did not start.')), 3_000);
    child.once('message', message => {
      clearTimeout(timer);
      if (message === 'ready') resolveReady();
      else rejectReady(new Error('Unexpected old-router readiness message.'));
    });
    child.once('error', error => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      rejectReady(new Error(`Old router exited before readiness (${code}).`));
    });
  });

  const nextOptions = {
    stateDirectory,
    readinessToken: createClaudeGptTlsRouterReadinessToken(),
    socketTakeoverTimeoutMs: 3_000,
  };
  const nextReadiness = waitForClaudeGptTlsRouter(nextOptions, 3_000);
  child.kill('SIGTERM');
  replacement = await ensureClaudeGptTlsRouter(nextOptions);
  assert.deepEqual(await nextReadiness, replacement.env);
  assert.equal(replacement.status().running, true);
});

test('fails GPT routing closed when the localhost credential is unavailable', async t => {
  const fixture = await createFixture(t, { withCredential: false });
  const { handle, native, gpt } = fixture;
  const gptResponse = await requestRouter(handle, {
    body: JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[1] }),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer anthropic-secret',
    },
  });
  assert.equal(gptResponse.statusCode, 503);
  assert.equal(native.requests.length, 0);
  assert.equal(gpt.requests.length, 0);
  assert.doesNotMatch(gptResponse.body.toString(), /anthropic-secret/);

  const nativeResponse = await requestRouter(handle, {
    body: JSON.stringify({ model: 'claude-opus-4-6' }),
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer native-secret',
    },
  });
  assert.equal(nativeResponse.statusCode, 200);
  assert.equal(native.requests.length, 1);
  assert.equal(native.requests[0].headers.authorization, 'Bearer native-secret');
});

test('fails malformed, encoded, or oversized candidates closed to native Claude', async t => {
  const fixture = await createFixture(t, { maxRequestBodyBytes: 64 });
  const malformed = await requestRouter(fixture.handle, {
    body: '{"model":',
    headers: { 'content-type': 'application/json', authorization: 'Bearer native-malformed' },
  });
  assert.equal(malformed.statusCode, 200);

  const oversizedBody = JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[2], padding: 'x'.repeat(128) });
  const oversized = await requestRouter(fixture.handle, {
    body: oversizedBody,
    headers: { 'content-type': 'application/json', authorization: 'Bearer native-oversized' },
  });
  assert.equal(oversized.statusCode, 200);
  const encoded = await requestRouter(fixture.handle, {
    body: JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[0] }),
    headers: {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      authorization: 'Bearer native-encoded',
    },
  });
  assert.equal(encoded.statusCode, 200);
  assert.equal(fixture.native.requests.length, 3);
  assert.equal(fixture.gpt.requests.length, 0);
  assert.equal(fixture.native.requests[0].headers.authorization, 'Bearer native-malformed');
  assert.equal(fixture.native.requests[0].body.toString(), '{"model":');
  assert.equal(fixture.native.requests[1].headers.authorization, 'Bearer native-oversized');
  assert.equal(fixture.native.requests[1].body.toString(), oversizedBody);
  assert.equal(fixture.native.requests[2].headers.authorization, 'Bearer native-encoded');
});

test('routes aliases only on exact POST message endpoints and validates Host', async t => {
  const fixture = await createFixture(t);
  const body = JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[0] });
  for (const request of [
    { method: 'GET', path: '/v1/messages', body: '' },
    { method: 'POST', path: '/v1/messages/batches' },
    { method: 'POST', path: '/v1/complete' },
  ]) {
    const response = await requestRouter(fixture.handle, {
      ...request,
      body: request.body ?? body,
      headers: { 'content-type': 'application/json', authorization: 'Bearer native-path' },
    });
    assert.equal(response.statusCode, 200, `${request.method} ${request.path}: ${response.body}`);
  }
  assert.equal(fixture.native.requests.length, 3);
  assert.equal(fixture.gpt.requests.length, 0);

  const wrongHost = await requestRouter(fixture.handle, {
    body,
    headers: { host: 'localhost', 'content-type': 'application/json' },
  });
  assert.equal(wrongHost.statusCode, 421);
  assert.equal(fixture.native.requests.length, 3);
});

test('scrubs every unapproved identity header before a GPT request reaches localhost', async t => {
  const fixture = await createFixture(t);
  await requestRouter(fixture.handle, {
    body: JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[1] }),
    path: '/v1/messages/count_tokens',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-2024',
      authorization: 'Bearer native-secret',
      cookie: 'session=native-secret',
      'x-api-key': 'native-secret',
      'anthropic-user-profile-id': 'private-profile',
      'x-stainless-package-version': 'private-client',
      'x-invented-account-id': 'private-account',
      'user-agent': 'private-agent',
    },
  });
  assert.equal(fixture.gpt.requests.length, 1);
  const headers = fixture.gpt.requests[0].headers;
  assert.equal(headers.authorization, 'Bearer test-local-gateway-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['anthropic-beta'], 'tools-2024');
  for (const name of [
    'cookie', 'x-api-key', 'anthropic-user-profile-id', 'x-stainless-package-version',
    'x-invented-account-id', 'user-agent',
  ]) assert.equal(headers[name], undefined);
});

test('rejects a group-readable localhost credential without exposing native auth', async t => {
  const fixture = await createFixture(t);
  await chmod(fixture.credentialPath, 0o644);
  const response = await requestRouter(fixture.handle, {
    body: JSON.stringify({ model: CLAUDE_GPT_MODEL_ALIASES[0] }),
    headers: { 'content-type': 'application/json', authorization: 'Bearer native-secret' },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(fixture.native.requests.length, 0);
  assert.equal(fixture.gpt.requests.length, 0);
  assert.doesNotMatch(response.body.toString(), /native-secret/);
});

test('rejects broad state paths and non-exact production upstreams', () => {
  assert.throws(() => getClaudeGptTlsRouterEnvironment({ stateDirectory: '/' }), /too broad/);
  assert.throws(
    () => getClaudeGptTlsRouterEnvironment({ nativeUpstream: 'https://example.com' }),
    /native upstream must be exact/,
  );
  assert.throws(
    () => getClaudeGptTlsRouterEnvironment({ gptUpstream: 'http://example.com:8317' }),
    /GPT gateway must use a loopback hostname|GPT upstream must be an exact loopback origin/,
  );
});
