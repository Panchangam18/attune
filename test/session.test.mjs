import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { readStylesheet } from '../dist/config.js';
import { getChromiumRuntime } from '../dist/scan.js';
import { HOST_ROLE_CATALOG } from '../dist/host-roles.js';
import {
  buildInspectionExpression,
  buildSemanticElementsExpression,
  buildSemanticStyleProbeExpression,
  buildStyleInjectionExpression,
  compactInspection,
  compactSemanticElements,
  getClaudeProcessRoutingState,
  readHostFingerprints,
  resolveClaudeCliPath,
  shouldEnableClaudeCodexProxy,
  shouldEnableClaudeGptModels,
  splitWorkspaceSource,
  TargetStylesheetSession,
  writeHostFingerprints,
} from '../dist/session.js';

const execFileAsync = promisify(execFile);
const sessionModuleUrl = new URL('../dist/session.js', import.meta.url).href;
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const mockCodexBridge = fileURLToPath(
  new URL('./fixtures/mock-claude-codex-bridge.mjs', import.meta.url),
);

test('Claude Codex proxy is gated by both the ChatGPT bundle and Attune launch flag', () => {
  assert.equal(shouldEnableClaudeCodexProxy('com.openai.codex', {
    ATTUNE_CLAUDE_CODEX_PROXY_ENABLED: '1',
  }), true);
  assert.equal(shouldEnableClaudeCodexProxy('com.openai.codex', {
    ATTUNE_CLAUDE_CODEX_PROXY_ENABLED: '0',
  }), false);
  assert.equal(shouldEnableClaudeCodexProxy('com.anthropic.claudefordesktop', {
    ATTUNE_CLAUDE_CODEX_PROXY_ENABLED: '1',
  }), false);
});

test('Claude GPT routing is gated by both the Claude bundle and Attune launch flag', () => {
  assert.equal(shouldEnableClaudeGptModels('com.anthropic.claudefordesktop', {
    ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '1',
  }), true);
  assert.equal(shouldEnableClaudeGptModels('com.anthropic.claudefordesktop', {
    ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '0',
  }), false);
  assert.equal(shouldEnableClaudeGptModels('com.openai.codex', {
    ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '1',
  }), false);
});

test('Claude GPT Bun preload restores only an authenticated loopback base URL', async t => {
  const root = await mkdtemp('/tmp/attune-claude-preload-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const preloadUrl = new URL('../dist/claude-gpt-cli-preload.js', import.meta.url).href;
  const loopbackBaseUrl = 'http://127.0.0.1:48123/.attune/1234567890abcdef';
  const diagnosticsPath = join(root, '.attune', 'logs', 'claude-gpt-routing.jsonl');
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(preloadUrl)}); process.stdout.write(JSON.stringify({ baseUrl: process.env.ANTHROPIC_BASE_URL, firstParty: process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, privateBaseUrl: process.env.ATTUNE_CLAUDE_GPT_BASE_URL ?? null }))`,
  ], {
    env: {
      ...process.env,
      HOME: root,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ATTUNE_CLAUDE_GPT_BASE_URL: loopbackBaseUrl,
      ATTUNE_CLAUDE_GPT_DIAGNOSTICS_PATH: diagnosticsPath,
    },
  });
  assert.deepEqual(JSON.parse(stdout), {
    baseUrl: loopbackBaseUrl,
    firstParty: 'true',
    privateBaseUrl: null,
  });

  const invalid = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(preloadUrl)}); process.stdout.write(process.env.ANTHROPIC_BASE_URL ?? 'missing')`,
  ], {
    env: {
      ...process.env,
      HOME: root,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ATTUNE_CLAUDE_GPT_BASE_URL: 'https://attacker.example/.attune/1234567890abcdef',
      ATTUNE_CLAUDE_GPT_DIAGNOSTICS_PATH: diagnosticsPath,
    },
  });
  assert.equal(invalid.stdout, 'https://api.anthropic.com');
  const diagnosticText = await readFile(diagnosticsPath, 'utf8');
  const diagnostics = diagnosticText.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(diagnostics[0].event, 'cliPreloadApplied');
  assert.equal(diagnostics[0].previousBaseRoute, 'anthropicApi');
  assert.equal(diagnostics[0].route, 'loopbackRouter');
  assert.equal(diagnostics[1].event, 'cliPreloadRejected');
  assert.equal(diagnostics[1].reason, 'invalidBaseUrl');
  assert.doesNotMatch(diagnosticText, /1234567890abcdef|attacker\.example/);
});

test('launch publishes a provisional owner and honors cancellation before app spawn', async t => {
  const root = await mkdtemp('/tmp/attune-launch-cancel-');
  const home = join(root, 'home');
  const appPath = join(root, 'Claude Test.app');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Claude Test');
  const markerPath = join(root, 'app-started');
  const stateDirectory = join(home, '.attune', 'claude-gpt-router');
  const socketPath = join(stateDirectory, 'api.anthropic.com.sock');
  const sessionPath = join(
    home,
    '.attune',
    'sessions',
    'com.anthropic.claudefordesktop.json',
  );
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(executablePath, '#!/bin/sh\n: > "$ATTUNE_FAKE_APP_MARKER"\n', { mode: 0o755 });

  const blocker = createNetServer(socket => socket.destroy());
  await new Promise((resolveListen, rejectListen) => {
    blocker.once('error', rejectListen);
    blocker.listen(socketPath, resolveListen);
  });
  let blockerClosed = false;
  const closeBlocker = async () => {
    if (blockerClosed) return;
    blockerClosed = true;
    await new Promise((resolveClose, rejectClose) => {
      blocker.close(error => error ? rejectClose(error) : resolveClose());
    });
  };

  const child = spawnLaunchHarness({
    home,
    app: {
      name: 'Claude Test',
      path: appPath,
      bundleId: 'com.anthropic.claudefordesktop',
      runtime: 'electron',
    },
    extraEnvironment: {
      ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '1',
      ATTUNE_CODEX_APP_SERVER_PATH: mockCodexBridge,
      ATTUNE_FAKE_APP_MARKER: markerPath,
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closeBlocker().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  await waitForPath(sessionPath, 5_000);
  const provisional = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.ok(provisional.watcherPid > 0);
  assert.equal(provisional.appPid, undefined);
  await rm(sessionPath, { force: true });
  await closeBlocker();

  const result = parseLaunchHarnessOutput(await collectChild(child, 15_000));
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled before the app started/);
  await assert.rejects(access(markerPath), { code: 'ENOENT' });
  await assert.rejects(access(sessionPath), { code: 'ENOENT' });
});

test('launch cleans up its watcher and provisional record after async app spawn failure', async t => {
  const root = await mkdtemp('/tmp/attune-launch-error-');
  const home = join(root, 'home');
  const appPath = join(root, 'Broken Test.app');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Broken Test');
  const appId = 'com.example.attune-broken-test';
  const sessionPath = join(home, '.attune', 'sessions', `${appId}.json`);
  const configPath = join(home, '.attune', 'config', `${appId}.json`);
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

  const child = spawnLaunchHarness({
    home,
    app: {
      name: 'Broken Test',
      path: appPath,
      bundleId: appId,
      runtime: 'electron',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const result = parseLaunchHarnessOutput(await collectChild(child, 10_000));
  assert.equal(result.ok, false);
  assert.match(result.error, /could not start/);
  await assert.rejects(access(sessionPath), { code: 'ENOENT' });
  await waitUntil(async () => !await processListContains(configPath), 3_000);
  assert.equal(await processListContains(configPath), false);
});

test('GPT-enabled Claude launch keeps API routing inside the CLI preload', async t => {
  const root = await mkdtemp('/tmp/attune-launch-native-profile-');
  const home = join(root, 'home');
  const appPath = join(root, 'Claude Profile Test.app');
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Claude Profile Test');
  const markerPath = join(root, 'child-profile');
  const argumentsPath = join(root, 'child-arguments');
  const baseUrlPath = join(root, 'child-base-url');
  const firstPartyPath = join(root, 'child-first-party');
  const httpsProxyPath = join(root, 'child-https-proxy');
  const bunOptionsPath = join(root, 'child-bun-options');
  const privateBaseUrlPath = join(root, 'child-private-base-url');
  const diagnosticsPath = join(root, 'child-diagnostics-path');
  const sessionPath = join(
    home,
    '.attune',
    'sessions',
    'com.anthropic.claudefordesktop.json',
  );
  let watcherPid = 0;
  await mkdir(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(
    executablePath,
    '#!/bin/sh\nprintf "%s" "${CLAUDE_USER_DATA_DIR-unset}" > "$ATTUNE_FAKE_APP_MARKER"\nprintf "%s\\n" "$@" > "$ATTUNE_FAKE_ARGS_MARKER"\nprintf "%s" "${ANTHROPIC_BASE_URL-unset}" > "$ATTUNE_FAKE_BASE_URL_MARKER"\nprintf "%s" "${_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL-unset}" > "$ATTUNE_FAKE_FIRST_PARTY_MARKER"\nprintf "%s" "${HTTPS_PROXY-unset}" > "$ATTUNE_FAKE_HTTPS_PROXY_MARKER"\nprintf "%s" "${BUN_OPTIONS-unset}" > "$ATTUNE_FAKE_BUN_OPTIONS_MARKER"\nprintf "%s" "${ATTUNE_CLAUDE_GPT_BASE_URL-unset}" > "$ATTUNE_FAKE_PRIVATE_BASE_URL_MARKER"\nprintf "%s" "${ATTUNE_CLAUDE_GPT_DIAGNOSTICS_PATH-unset}" > "$ATTUNE_FAKE_DIAGNOSTICS_PATH_MARKER"\n',
    { mode: 0o755 },
  );

  const child = spawnLaunchHarness({
    home,
    app: {
      name: 'Claude Profile Test',
      path: appPath,
      bundleId: 'com.anthropic.claudefordesktop',
      runtime: 'electron',
    },
    extraEnvironment: {
      ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '1',
      ATTUNE_CODEX_APP_SERVER_PATH: mockCodexBridge,
      ATTUNE_FAKE_APP_MARKER: markerPath,
      ATTUNE_FAKE_ARGS_MARKER: argumentsPath,
      ATTUNE_FAKE_BASE_URL_MARKER: baseUrlPath,
      ATTUNE_FAKE_FIRST_PARTY_MARKER: firstPartyPath,
      ATTUNE_FAKE_HTTPS_PROXY_MARKER: httpsProxyPath,
      ATTUNE_FAKE_BUN_OPTIONS_MARKER: bunOptionsPath,
      ATTUNE_FAKE_PRIVATE_BASE_URL_MARKER: privateBaseUrlPath,
      ATTUNE_FAKE_DIAGNOSTICS_PATH_MARKER: diagnosticsPath,
      CLAUDE_USER_DATA_DIR: join(root, 'wrong-profile'),
      BUN_OPTIONS: '--smol',
      ANTHROPIC_BASE_URL: 'https://parent-base.example',
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: 'false',
      HTTPS_PROXY: 'http://parent-proxy.example:8443',
    },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (watcherPid > 0 && processIsAlive(watcherPid)) process.kill(watcherPid, 'SIGTERM');
    await rm(root, { recursive: true, force: true });
  });

  const result = parseLaunchHarnessOutput(await collectChild(child, 15_000));
  assert.equal(result.ok, true);
  await waitForPath(markerPath, 5_000);
  assert.equal(await readFile(markerPath, 'utf8'), 'unset');
  const launchedArguments = await readFile(argumentsPath, 'utf8');
  assert.match(launchedArguments, /--proxy-pac-url=http:\/\/127\.0\.0\.1:\d+\/proxy\.pac/);
  assert.match(launchedArguments, /--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]+=*/);
  assert.doesNotMatch(launchedArguments, /remote-debugging/);
  assert.equal(await readFile(baseUrlPath, 'utf8'), 'https://parent-base.example');
  assert.equal(await readFile(firstPartyPath, 'utf8'), 'false');
  assert.equal(await readFile(httpsProxyPath, 'utf8'), 'http://parent-proxy.example:8443');
  assert.match(
    await readFile(bunOptionsPath, 'utf8'),
    /^--smol --preload=file:\/\/\/.*\/dist\/claude-gpt-cli-preload\.js$/,
  );
  assert.match(
    await readFile(privateBaseUrlPath, 'utf8'),
    /^http:\/\/127\.0\.0\.1:\d+\/\.attune\/[A-Za-z0-9_-]{16,128}$/,
  );
  assert.equal(
    await readFile(diagnosticsPath, 'utf8'),
    join(home, '.attune', 'logs', 'claude-gpt-routing.jsonl'),
  );
  watcherPid = JSON.parse(await readFile(sessionPath, 'utf8')).watcherPid;
  process.kill(watcherPid, 'SIGTERM');
  await waitUntil(() => !processIsAlive(watcherPid), 5_000);
});

test('Claude watcher distinguishes routed launches, updater relaunches, and helper processes', () => {
  const executablePath = '/Applications/Claude.app/Contents/MacOS/Claude';
  const launchConfiguration = {
    proxyPacUrl: 'http://127.0.0.1:48123/proxy.pac',
    spkiHash: 'abc+/=',
  };
  assert.equal(getClaudeProcessRoutingState('', executablePath, launchConfiguration), 'absent');
  assert.equal(getClaudeProcessRoutingState([
    `100 ${executablePath} --proxy-pac-url=${launchConfiguration.proxyPacUrl} --ignore-certificate-errors-spki-list=${launchConfiguration.spkiHash}`,
    `101 ${executablePath} Helper --type=renderer`,
  ].join('\n'), executablePath, launchConfiguration), 'routed');
  assert.equal(getClaudeProcessRoutingState(
    `102 ${executablePath} --updated-launch`,
    executablePath,
    launchConfiguration,
  ), 'unrouted');
  assert.equal(getClaudeProcessRoutingState(
    '103 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer',
    executablePath,
    launchConfiguration,
  ), 'absent');
});

test('stopSession signals only the watcher process that owns its session record', async t => {
  const root = await mkdtemp('/tmp/attune-stop-owned-watcher-');
  const home = join(root, 'home');
  const sessions = join(home, '.attune', 'sessions');
  const appId = 'com.example.stop-owned';
  const sessionPath = join(sessions, `${appId}.json`);
  const watcherToken = '12345678-1234-4234-8234-123456789abc';
  await mkdir(sessions, { recursive: true });
  const watcher = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
    '_watch',
    '/tmp/config.json',
    '48123',
    sessionPath,
    watcherToken,
  ], { stdio: 'ignore' });
  const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(async () => {
    if (watcher.exitCode === null) watcher.kill('SIGKILL');
    if (innocent.exitCode === null) innocent.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([waitForSpawn(watcher), waitForSpawn(innocent)]);

  await writeFile(sessionPath, JSON.stringify(watcherSession(watcher.pid, 48123, {
    appId,
    watcherToken,
  })));
  assert.equal(await runStopSessionHarness(home, appId), true);
  await waitUntil(() => !processIsAlive(watcher.pid), 3_000);
  assert.equal(processIsAlive(watcher.pid), false);

  await writeFile(sessionPath, JSON.stringify(watcherSession(innocent.pid, 48123, {
    appId,
    watcherToken,
  })));
  assert.equal(await runStopSessionHarness(home, appId), true);
  assert.equal(processIsAlive(innocent.pid), true);
  await assert.rejects(access(sessionPath), { code: 'ENOENT' });
});

test('a stale watcher cannot publish over a replacement session', async t => {
  const root = await mkdtemp('/tmp/attune-watcher-publish-race-');
  const home = join(root, 'home');
  const configPath = join(root, 'config.json');
  const sessionPath = join(root, 'session.json');
  await writeFile(configPath, JSON.stringify({ css: '' }));

  let requestCount = 0;
  let firstResponse;
  let secondResponse;
  let resolveFirstRequest;
  let resolveSecondRequest;
  let resolveThirdRequest;
  const firstRequest = new Promise(resolve => { resolveFirstRequest = resolve; });
  const secondRequest = new Promise(resolve => { resolveSecondRequest = resolve; });
  const thirdRequest = new Promise(resolve => { resolveThirdRequest = resolve; });
  const devtools = createHttpServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstResponse = response;
      resolveFirstRequest();
      return;
    }
    if (requestCount === 2) {
      secondResponse = response;
      resolveSecondRequest();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
    if (requestCount === 3) resolveThirdRequest();
  });
  const port = await listenOnLoopback(devtools);
  let child;
  t.after(async () => {
    firstResponse?.destroy();
    secondResponse?.destroy();
    if (child?.exitCode === null) child.kill('SIGKILL');
    await closeServer(devtools);
    await rm(root, { recursive: true, force: true });
  });

  child = spawnWatcherHarness({
    home,
    configPath,
    sessionPath,
    port,
    options: { pollIntervalMs: 30, maxMissedPolls: 20 },
  });
  const completion = collectChild(child, 10_000);
  assert.ok(child.pid > 0);
  await writeFile(sessionPath, JSON.stringify(watcherSession(child.pid, port)));
  await firstRequest;
  firstResponse.writeHead(500);
  firstResponse.end();
  await waitUntil(async () => JSON.parse(await readFile(sessionPath, 'utf8')).status === 'waiting', 3_000);
  await secondRequest;

  const replacement = watcherSession(process.pid, port, {
    appId: 'com.example.replacement',
    status: 'starting',
    targetCount: 73,
    updatedAt: '2026-08-08T12:00:00.000Z',
  });
  await writeFile(sessionPath, JSON.stringify(replacement));
  secondResponse.writeHead(200, { 'content-type': 'application/json' });
  secondResponse.end('[]');
  await thirdRequest;
  assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')), replacement);

  child.kill('SIGTERM');
  const result = parseLaunchHarnessOutput(await completion);
  assert.equal(result.ok, true);
});

test('a stale watcher cannot remove a replacement session at its miss limit', async t => {
  const root = await mkdtemp('/tmp/attune-watcher-remove-race-');
  const home = join(root, 'home');
  const configPath = join(root, 'config.json');
  const sessionPath = join(root, 'session.json');
  await writeFile(configPath, JSON.stringify({ css: '' }));

  let requestCount = 0;
  let firstResponse;
  let secondResponse;
  let resolveFirstRequest;
  let resolveSecondRequest;
  const firstRequest = new Promise(resolve => { resolveFirstRequest = resolve; });
  const secondRequest = new Promise(resolve => { resolveSecondRequest = resolve; });
  const devtools = createHttpServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      firstResponse = response;
      resolveFirstRequest();
      return;
    }
    secondResponse = response;
    resolveSecondRequest();
  });
  const port = await listenOnLoopback(devtools);
  let child;
  t.after(async () => {
    firstResponse?.destroy();
    secondResponse?.destroy();
    if (child?.exitCode === null) child.kill('SIGKILL');
    await closeServer(devtools);
    await rm(root, { recursive: true, force: true });
  });

  child = spawnWatcherHarness({
    home,
    configPath,
    sessionPath,
    port,
    options: { pollIntervalMs: 30, maxMissedPolls: 2 },
  });
  const completion = collectChild(child, 10_000);
  assert.ok(child.pid > 0);
  await writeFile(sessionPath, JSON.stringify(watcherSession(child.pid, port)));
  await firstRequest;
  firstResponse.writeHead(500);
  firstResponse.end();
  await waitUntil(async () => JSON.parse(await readFile(sessionPath, 'utf8')).status === 'waiting', 3_000);
  await secondRequest;

  const replacement = watcherSession(process.pid, port, {
    appId: 'com.example.replacement',
    status: 'attached',
    targetCount: 41,
    updatedAt: '2026-08-08T12:30:00.000Z',
  });
  await writeFile(sessionPath, JSON.stringify(replacement));
  secondResponse.writeHead(500);
  secondResponse.end();

  const result = parseLaunchHarnessOutput(await completion);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(await readFile(sessionPath, 'utf8')), replacement);
});

test('Claude CLI path honors an explicit Attune override', () => {
  assert.equal(resolveClaudeCliPath({
    ATTUNE_CLAUDE_CLI_PATH: '/custom/bin/claude',
    PATH: '',
  }), '/custom/bin/claude');
});

test('inspection expression is valid JavaScript and requests agent-relevant context', () => {
  const expression = buildInspectionExpression();
  assert.doesNotThrow(() => new vm.Script(expression));
  assert.match(expression, /Page|viewport|elements/);
  assert.match(expression, /data-testid/);
  assert.match(expression, /attuneStylePresent/);
});

test('semantic elements expression is valid, bounded, and publishes stable role selectors', () => {
  const expression = buildSemanticElementsExpression({
    'slack.composer': { app: 'Slack', description: 'The message composer.' },
  });
  assert.doesNotThrow(() => new vm.Script(expression));
  assert.match(expression, /__attune-agent-elements/);
  assert.match(expression, /data-attune-host-roles/);
  assert.match(expression, /mapper\.request/);
  assert.match(expression, /Object\.entries\(catalog\)\.flatMap/);
  assert.match(expression, /slice\(0, length\)/);
});

test('semantic style probe validates CSS and requested role mappings without arbitrary input', () => {
  const expression = buildSemanticStyleProbeExpression('expected-hash', ['slack.composer']);
  assert.doesNotThrow(() => new vm.Script(expression));
  assert.match(expression, /expected-hash/);
  assert.match(expression, /slack\.composer/);
  assert.match(expression, /__attuneHost/);
});

test('semantic element output omits screenshot artifacts unless visual capture was requested', () => {
  const compact = compactSemanticElements({
    appId: 'com.example.app',
    appName: 'Example',
    capturedAt: '2026-08-07T00:00:00.000Z',
    ephemeral: false,
    expiresAt: null,
    session: { status: 'attached', port: 12345, targetCount: 1 },
    pages: [{
      title: 'Example',
      url: 'app://example',
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      screenshotPath: null,
      compatibility: 'compatible',
      elements: [],
      unavailableRoles: [],
    }],
  });
  assert.equal('artifacts' in compact, false);
});

test('compact inspection bounds immediate agent context', () => {
  const elements = Array.from({ length: 40 }, (_, index) => ({
    selector: `[data-testid="item-${index}"]`,
    stability: 'high',
    tag: 'button',
    role: 'button',
    label: `Item ${index}`,
    text: `Visible item ${index}`,
    bounds: { x: index, y: index, width: 100, height: 30 },
    styles: {
      display: 'block',
      position: 'static',
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgb(255, 255, 255)',
      fontSize: '14px',
    },
  }));
  const result = compactInspection({
    appId: 'com.example.app',
    appName: 'Example',
    capturedAt: '2026-07-24T00:00:00.000Z',
    inspectionPath: '/tmp/attune-inspect-test/inspection.json',
    ephemeral: true,
    expiresAt: '2026-07-25T00:00:00.000Z',
    session: { status: 'attached', port: 12345, targetCount: 1 },
    pages: [{
      title: 'Example',
      url: 'app://example',
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      screenshotPath: '/tmp/attune-inspect-test/page.png',
      attuneStylePresent: true,
      elements,
    }],
  });

  assert.equal(result.primaryPage.selectorSample.length, 24);
  assert.equal(result.primaryPage.elementCount, 40);
  assert.equal('styles' in result.primaryPage.selectorSample[0], false);
  assert.equal(result.artifacts.ephemeral, true);
});

test('style injection expression serializes and manages stylesheet text safely', () => {
  const css = "html::before { content: 'quoted \\ value'; }";
  const expression = buildStyleInjectionExpression(css);
  const styles = new Map();
  const document = {
    head: {
      append(style) {
        styles.set(style.id, style);
      },
    },
    createElement() {
      return {
        dataset: {},
        remove() {
          styles.delete(this.id);
        },
      };
    },
    getElementById(id) {
      return styles.get(id) || null;
    },
  };

  const window = {};

  assert.equal(vm.runInNewContext(expression, { document, window }), 'applied');
  assert.equal(styles.get('attune-custom-stylesheet').textContent, css);
  assert.equal(vm.runInNewContext(expression, { document, window }), 'current');
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(''), { document, window }), 'removed');
  assert.equal(styles.size, 0);
});

test('style injection expression runs optional workspace script blocks', () => {
  const source = `body { color: teal; }

/* @attune-script
window.__attuneScriptRuns = (window.__attuneScriptRuns || 0) + 1;
window.__attuneRegisterCleanup?.(() => {
  window.__attuneScriptCleanups = (window.__attuneScriptCleanups || 0) + 1;
});
@end-attune-script */`;
  const styles = new Map();
  const document = {
    head: {
      append(style) {
        styles.set(style.id, style);
      },
    },
    createElement() {
      return {
        dataset: {},
        remove() {
          styles.delete(this.id);
        },
      };
    },
    getElementById(id) {
      return styles.get(id) || null;
    },
  };
  const window = {};

  assert.deepEqual(splitWorkspaceSource(source), {
    css: 'body { color: teal; }',
    script: 'window.__attuneScriptRuns = (window.__attuneScriptRuns || 0) + 1;\nwindow.__attuneRegisterCleanup?.(() => {\n  window.__attuneScriptCleanups = (window.__attuneScriptCleanups || 0) + 1;\n});',
    bindingSets: [],
  });
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(source), { document, window, console }), 'applied');
  assert.equal(styles.get('attune-custom-stylesheet').textContent, 'body { color: teal; }');
  assert.equal(window.__attuneScriptRuns, 1);
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(source), { document, window, console }), 'current');
  assert.equal(window.__attuneScriptRuns, 1);
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression('body { color: plum; }'), { document, window, console }), 'applied');
  assert.equal(window.__attuneScriptCleanups, 1);
});

function spawnLaunchHarness({ home, app, extraEnvironment = {} }) {
  const source = `
    import { launch } from ${JSON.stringify(sessionModuleUrl)};
    const app = JSON.parse(process.env.ATTUNE_TEST_APP);
    try {
      const result = await launch(app, process.env.ATTUNE_TEST_CLI_PATH);
      console.log(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      HOME: home,
      ATTUNE_TEST_APP: JSON.stringify(app),
      ATTUNE_TEST_CLI_PATH: cliPath,
      ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '0',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnWatcherHarness({ home, configPath, sessionPath, port, options }) {
  const source = `
    import { runWatcher } from ${JSON.stringify(sessionModuleUrl)};
    try {
      await runWatcher(
        ${JSON.stringify(configPath)},
        ${JSON.stringify(port)},
        ${JSON.stringify(sessionPath)},
        ${JSON.stringify(options)},
      );
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      ...process.env,
      HOME: home,
      ATTUNE_CLAUDE_GPT_MODELS_ENABLED: '0',
      ATTUNE_WATCHER_APP_ID: 'com.example.watcher-race',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runStopSessionHarness(home, appId) {
  const source = `
    import { stopSession } from ${JSON.stringify(sessionModuleUrl)};
    console.log(JSON.stringify(stopSession(${JSON.stringify(appId)})));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = await collectChild(child, 5_000);
  return JSON.parse(stdout.trim());
}

function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function watcherSession(watcherPid, port, overrides = {}) {
  return {
    appId: 'com.example.watcher-race',
    appPath: '/Applications/Watcher Race.app',
    port,
    status: 'starting',
    targetCount: 0,
    updatedAt: '2026-08-08T11:00:00.000Z',
    watcherPid,
    ...overrides,
  };
}

async function listenOnLoopback(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolveClose => server.close(resolveClose));
}

function collectChild(child, timeoutMs) {
  return new Promise((resolveChild, rejectChild) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectChild(new Error(`Launch harness timed out. ${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolveChild(stdout);
      else rejectChild(new Error(`Launch harness exited ${code}. ${stderr}`));
    });
  });
}

function parseLaunchHarnessOutput(stdout) {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  assert.ok(line, 'Launch harness did not return a result.');
  return JSON.parse(line);
}

async function waitForPath(path, timeoutMs) {
  await waitUntil(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }, timeoutMs);
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Condition did not become true before timeout.');
}

async function processListContains(pattern) {
  try {
    await execFileAsync('pgrep', ['-f', pattern]);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('resident target sessions send only source, bridge, and recovery deltas', async () => {
  const createRenderer = () => {
    const styles = new Map();
    const document = {
      head: {
        append(style) {
          styles.set(style.id, style);
        },
      },
      createElement() {
        return {
          dataset: {},
          remove() {
            styles.delete(this.id);
          },
        };
      },
      getElementById(id) {
        return styles.get(id) || null;
      },
    };
    return { styles, context: { document, window: {}, console } };
  };

  let renderer = createRenderer();
  const commands = [];
  const transport = {
    async send(method, params = {}) {
      commands.push({ method, params });
      if (method !== 'Runtime.evaluate') return {};
      const value = vm.runInNewContext(params.expression, renderer.context);
      return { result: { value } };
    },
    close() {},
  };
  const session = new TargetStylesheetSession(transport);
  const script = `window.__residentRuns = (window.__residentRuns || 0) + 1;
window.__attuneRegisterCleanup?.(() => {
  window.__residentCleanups = (window.__residentCleanups || 0) + 1;
});`;
  const source = `body { color: teal; }
/* @attune-script
${script}
@end-attune-script */`;

  await session.sync(source, { todos: 1 }, 1_000);
  assert.deepEqual(commands.slice(0, 2).map(command => command.method), [
    'Page.enable',
    'Page.setBypassCSP',
  ]);
  assert.equal(commands.filter(command => command.method === 'Runtime.evaluate').length, 1);
  assert.equal(renderer.context.window.__residentRuns, 1);

  await session.sync(source, { todos: 1 }, 1_500);
  assert.equal(commands.filter(command => command.method === 'Runtime.evaluate').length, 1);

  session.invalidate();
  await session.sync(source, { todos: 1 }, 1_750);
  assert.equal(commands.filter(command => command.method === 'Runtime.evaluate').length, 2);
  assert.equal(renderer.context.window.__residentRuns, 1);

  await session.sync(source, { todos: 2 }, 2_000);
  const bridgeUpdate = commands.at(-1);
  assert.equal(bridgeUpdate.method, 'Runtime.evaluate');
  assert.match(bridgeUpdate.params.expression, /return 'updated'/);
  assert.doesNotMatch(bridgeUpdate.params.expression, /color: teal/);
  assert.equal(renderer.context.window.__attuneWorkspaceBridge.todos, 2);
  assert.equal(renderer.context.window.__residentRuns, 1);

  const recolored = source.replace('color: teal', 'color: plum');
  await session.sync(recolored, { todos: 2 }, 2_500);
  assert.equal(renderer.styles.get('attune-custom-stylesheet').textContent, 'body { color: plum; }');
  assert.equal(renderer.context.window.__residentRuns, 1);
  assert.equal(renderer.context.window.__residentCleanups, undefined);

  await session.sync(recolored, { todos: 2 }, 8_000);
  assert.equal(commands.at(-1).method, 'Runtime.evaluate');
  assert.match(commands.at(-1).params.expression, /styleElementHash/);

  renderer = createRenderer();
  const evaluationsBeforeRecovery = commands.filter(command => command.method === 'Runtime.evaluate').length;
  await session.sync(recolored, { todos: 2 }, 14_000);
  const evaluationsAfterRecovery = commands.filter(command => command.method === 'Runtime.evaluate').length;
  assert.equal(evaluationsAfterRecovery, evaluationsBeforeRecovery + 2);
  assert.equal(renderer.styles.get('attune-custom-stylesheet').textContent, 'body { color: plum; }');
  assert.equal(renderer.context.window.__residentRuns, 1);
});

test('host bindings are extracted and mapped before attunement scripts run', () => {
  const source = `/* @attune-bindings
{"schemaVersion":1,"attunementId":"codex-multi-chat","appName":"Codex","bindings":[{"name":"main","role":"codex.primaryChat","required":true},{"name":"composer","role":"codex.composer","required":false},{"name":"composerSurface","role":"codex.composerSurface","required":false},{"name":"header","role":"codex.chatHeader","required":false}]}
@end-attune-bindings */

[data-attune-host-roles~="codex.primaryChat"] { display: flex; }

/* @attune-script
window.__mappedBeforeScript = Boolean(window.__attuneHost?.resolve('codex.primaryChat'));
@end-attune-script */`;
  const attributes = new Map();
  const composerPaintSurface = {
    isConnected: true,
    tagName: 'DIV',
    classList: ['bg-token-input-background'],
    querySelectorAll() { return []; },
    getAttribute() { return ''; },
    setAttribute(name, value) { attributes.set(`composer-paint-surface:${name}`, value); },
    removeAttribute(name) { attributes.delete(`composer-paint-surface:${name}`); },
    getBoundingClientRect() { return { width: 696, height: 92 }; },
  };
  const composerEditor = {
    isConnected: true,
    tagName: 'DIV',
    classList: [],
    parentElement: composerPaintSurface,
    querySelectorAll() { return []; },
    getAttribute(name) { return name === 'role' ? 'textbox' : ''; },
    setAttribute(name, value) { attributes.set(`composer-editor:${name}`, value); },
    removeAttribute(name) { attributes.delete(`composer-editor:${name}`); },
    getBoundingClientRect() { return { width: 680, height: 44 }; },
  };
  composerPaintSurface.contains = element => element === composerEditor;
  const composerChrome = {
    isConnected: true,
    tagName: 'DIV',
    classList: ['composer-surface-chrome'],
    querySelectorAll(selector) {
      return selector.includes('bg-token-input-background') ? [composerPaintSurface] : [];
    },
    getAttribute() { return ''; },
    setAttribute(name, value) { attributes.set(`composer-chrome:${name}`, value); },
    removeAttribute(name) { attributes.delete(`composer-chrome:${name}`); },
    getBoundingClientRect() { return { width: 700, height: 96 }; },
  };
  composerPaintSurface.parentElement = composerChrome;
  const composerRoot = {
    isConnected: true,
    tagName: 'DIV',
    classList: [],
    querySelectorAll(selector) {
      if (selector === '.composer-surface-chrome') return [composerChrome];
      if (selector.startsWith('#prompt-textarea')) return [composerEditor];
      return [];
    },
    getAttribute(name) { return name === 'data-codex-composer-root' ? 'true' : ''; },
    setAttribute(name, value) { attributes.set(`composer-root:${name}`, value); },
    removeAttribute(name) { attributes.delete(`composer-root:${name}`); },
    getBoundingClientRect() { return { width: 736, height: 98 }; },
  };
  composerChrome.parentElement = composerRoot;
  composerRoot.contains = element => [composerChrome, composerPaintSurface, composerEditor].includes(element);
  const header = {
    isConnected: true,
    setAttribute(name, value) { attributes.set(`header:${name}`, value); },
    removeAttribute(name) { attributes.delete(`header:${name}`); },
    getBoundingClientRect() { return { width: 600, height: 40 }; },
    querySelector() { return null; },
    hasAttribute() { return false; },
    classList: { contains() { return false; } },
    tagName: 'HEADER',
  };
  const action = {
    isConnected: true,
    getBoundingClientRect() { return { width: 28, height: 28 }; },
    closest(selector) { return selector === 'header' ? header : null; },
  };
  const main = {
    isConnected: true,
    tagName: 'MAIN',
    classList: { contains(name) { return name === 'main-surface'; } },
    hasAttribute(name) { return name === 'data-app-shell-main-surface'; },
    querySelector(selector) {
      if (selector === '[data-codex-composer-root]') return composerRoot;
      if (selector === '[data-app-action-timeline-scroll]') return {};
      if (selector === 'button[aria-label="Chat actions"]') return action;
      return null;
    },
    setAttribute(name, value) { attributes.set(`main:${name}`, value); },
    removeAttribute(name) { attributes.delete(`main:${name}`); },
    getBoundingClientRect() { return { width: 800, height: 600 }; },
  };
  const styles = new Map();
  const document = {
    documentElement: {},
    head: { append(style) { styles.set(style.id, style); } },
    createElement() {
      return {
        dataset: {},
        remove() { styles.delete(this.id); },
      };
    },
    getElementById(id) { return styles.get(id) || null; },
    querySelector(selector) {
      if (selector === '.app-header-tint') return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'main') return [main];
      if (selector === '[data-codex-composer-root]') return [composerRoot];
      if (selector.startsWith('#prompt-textarea')) return [composerEditor];
      if (selector === 'button[aria-label="Chat actions"]') return [action];
      return [];
    },
  };
  const window = {
    dispatchEvent() {},
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const context = {
    document,
    window,
    console,
    MutationObserver,
    CustomEvent,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    requestAnimationFrame: callback => { callback(); return 1; },
    cancelAnimationFrame() {},
  };

  const parsed = splitWorkspaceSource(source);
  assert.equal(parsed.bindingSets.length, 1);
  assert.equal(parsed.bindingSets[0].bindings[0].role, 'codex.primaryChat');
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(source), context), 'applied');
  assert.equal(window.__mappedBeforeScript, true);
  assert.equal(attributes.get('main:data-attune-host-roles'), 'codex.primaryChat');
  assert.equal(attributes.get('composer-root:data-attune-host-roles'), 'codex.composer');
  assert.equal(attributes.get('composer-paint-surface:data-attune-host-roles'), undefined);
  assert.equal(attributes.get('composer-chrome:data-attune-host-roles'), 'codex.composerSurface');
  assert.equal(attributes.get('header:data-attune-host-roles'), 'codex.chatHeader');
  assert.equal(window.__attuneCompatibilityReports['codex-multi-chat'].status, 'compatible');
});

test('host mapper publishes semantic strategies for every supported attunement surface', () => {
  const expression = buildStyleInjectionExpression('body { color: CanvasText; }');
  for (const role of Object.keys(HOST_ROLE_CATALOG)) {
    assert.match(expression, new RegExp(role.replace('.', '\\.')));
  }
});

function createFingerprintRenderer(candidates, deterministicCandidates = []) {
  const attributes = new Map();
  const styles = new Map();
  const makeElement = (name, overrides = {}) => ({
    name,
    isConnected: true,
    tagName: 'DIV',
    textContent: '',
    parentElement: null,
    classList: [],
    getAttribute() { return ''; },
    hasAttribute() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute(key, value) { attributes.set(`${name}:${key}`, value); },
    removeAttribute(key) { attributes.delete(`${name}:${key}`); },
    getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 40 }; },
    ...overrides,
  });
  const documentElement = makeElement('html', { tagName: 'HTML' });
  const body = makeElement('body', { tagName: 'BODY' });
  const document = {
    documentElement,
    body,
    head: { append(style) { styles.set(style.id, style); } },
    createElement() { return { dataset: {}, remove() { styles.delete(this.id); } }; },
    getElementById(id) { return styles.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === '[data-qa="texty_input"], [contenteditable="true"][role="textbox"]') {
        return deterministicCandidates;
      }
      if (selector === 'body *') return candidates;
      return [];
    },
  };
  const window = { dispatchEvent() {} };
  class MutationObserver { observe() {} disconnect() {} }
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  return {
    attributes,
    context: {
      document,
      window,
      console,
      innerWidth: 1000,
      innerHeight: 800,
      devicePixelRatio: 2,
      location: { href: 'app://test' },
      MutationObserver,
      CustomEvent,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      requestAnimationFrame: callback => { callback(); return 1; },
      cancelAnimationFrame() {},
    },
  };
}

test('semantic elements resolve a live host role and return its stable CSS selector', () => {
  const composer = {
    name: 'composer', isConnected: true, tagName: 'DIV', textContent: 'Message', innerText: 'Message',
    parentElement: null, classList: ['message-composer'],
    getAttribute(name) { return name === 'role' ? 'textbox' : name === 'aria-label' ? 'Message' : ''; },
    hasAttribute() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { x: 100, y: 700, width: 700, height: 60 }; },
  };
  const renderer = createFingerprintRenderer([], [composer]);
  const result = vm.runInNewContext(buildSemanticElementsExpression({
    'slack.composer': { app: 'Slack', description: 'The message composer.' },
  }), renderer.context);

  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].role, 'slack.composer');
  assert.equal(result.elements[0].selector, '[data-attune-host-roles~="slack.composer"]');
  assert.equal(result.elements[0].resolution.method, 'deterministic');
  assert.equal(result.unavailableRoles.length, 0);
});

const slackComposerSource = `/* @attune-bindings
{"schemaVersion":1,"attunementId":"slack-test","appName":"Slack","bindings":[{"name":"composer","role":"slack.composer","required":true}]}
@end-attune-bindings */

[data-attune-host-roles~="slack.composer"] { border: 1px solid; }`;

const savedSlackComposerFingerprint = {
  'slack.composer': {
    tag: 'div',
    role: 'textbox',
    label: 'Message',
    text: 'Write a message',
    attributes: { role: 'textbox', 'aria-label': 'Message' },
    classes: ['message-composer'],
    ancestor: { tag: 'form', role: 'form', label: 'Message form' },
    geometry: { horizontal: 'center', vertical: 'end', widthRatio: 0.7, heightRatio: 0.08 },
  },
};

test('host mapper recovers a changed element from a high-confidence fingerprint', () => {
  const parent = {
    tagName: 'FORM',
    getAttribute(name) { return name === 'role' ? 'form' : name === 'aria-label' ? 'Message form' : ''; },
  };
  const desired = {
    name: 'desired', isConnected: true, tagName: 'DIV', textContent: 'Write a message', parentElement: parent,
    classList: ['message-composer'],
    getAttribute(name) { return name === 'role' ? 'textbox' : name === 'aria-label' ? 'Message' : ''; },
    hasAttribute() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { x: 150, y: 704, width: 700, height: 64 }; },
  };
  const distractor = {
    ...desired,
    name: 'distractor', tagName: 'BUTTON', textContent: 'Cancel', classList: ['secondary-action'],
    getAttribute(name) { return name === 'role' ? 'button' : name === 'aria-label' ? 'Cancel' : ''; },
    getBoundingClientRect() { return { x: 10, y: 10, width: 80, height: 30 }; },
  };
  const renderer = createFingerprintRenderer([distractor, desired], [distractor]);
  desired.setAttribute = (key, value) => renderer.attributes.set(`desired:${key}`, value);
  desired.removeAttribute = key => renderer.attributes.delete(`desired:${key}`);

  assert.equal(vm.runInNewContext(
    buildStyleInjectionExpression(slackComposerSource, {}, savedSlackComposerFingerprint),
    renderer.context,
  ), 'applied');
  assert.equal(renderer.attributes.get('desired:data-attune-host-roles'), 'slack.composer');
  const capability = renderer.context.window.__attuneCompatibilityReports['slack-test'].capabilities.composer;
  assert.equal(capability.method, 'fingerprint');
  assert.ok(capability.confidence >= 0.72);
  assert.equal(
    JSON.stringify([...renderer.context.window.__attuneHost.roles()].sort()),
    JSON.stringify(Object.keys(HOST_ROLE_CATALOG).sort()),
  );
});

test('host mapper rejects ambiguous fingerprint matches', () => {
  const parent = { tagName: 'FORM', getAttribute() { return ''; } };
  const candidate = name => ({
    name, isConnected: true, tagName: 'DIV', textContent: 'Write a message', parentElement: parent,
    classList: ['message-composer'],
    getAttribute(key) { return key === 'role' ? 'textbox' : key === 'aria-label' ? 'Message' : ''; },
    hasAttribute() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {},
    getBoundingClientRect() { return { x: 150, y: 704, width: 700, height: 64 }; },
  });
  const renderer = createFingerprintRenderer([candidate('one'), candidate('two')]);
  vm.runInNewContext(
    buildStyleInjectionExpression(slackComposerSource, {}, savedSlackComposerFingerprint),
    renderer.context,
  );
  const report = renderer.context.window.__attuneCompatibilityReports['slack-test'];
  assert.equal(report.status, 'unavailable');
  assert.equal(report.capabilities.composer.method, 'unavailable');
  assert.equal(renderer.attributes.size, 0);
});

test('semantic host roles are published as an agent-readable catalog', () => {
  assert.equal(HOST_ROLE_CATALOG['codex.primaryChat'].app, 'Codex');
  assert.equal(
    HOST_ROLE_CATALOG['codex.composer'].description,
    'The outer composer component and layout container. It may be transparent or extend behind rounded corners; do not use it to recolor the visible chat box. Use codex.composerSurface instead.',
  );
  assert.match(HOST_ROLE_CATALOG['codex.composerSurface'].description, /style this one role directly/i);
  assert.match(HOST_ROLE_CATALOG['chatgpt.composer'].description, /inner prompt text-entry editor only/i);
  assert.match(HOST_ROLE_CATALOG['chatgpt.composer'].description, /excludes the composer surface/i);
  assert.match(HOST_ROLE_CATALOG['chatgpt.composer'].description, /use codex\.composerSurface when styling the visible rounded chat box/i);
  assert.equal(HOST_ROLE_CATALOG['claude.modelPicker'].app, 'Claude');
  assert.match(HOST_ROLE_CATALOG['slack.composer'].description, /composer/i);
  assert.match(HOST_ROLE_CATALOG['slack.primaryView'].description, /channel|conversation/i);
  assert.equal(Object.keys(HOST_ROLE_CATALOG).length, 37);
});

test('host fingerprints round-trip in isolated per-app stores and reject corrupt data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'attune-host-fingerprints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprints = { 'codex.primaryChat': { tag: 'main', role: 'main' } };

  writeHostFingerprints('com.openai.codex', fingerprints, root);
  assert.deepEqual(readHostFingerprints('com.openai.codex', root), fingerprints);
  assert.deepEqual(readHostFingerprints('com.tinyspeck.slackmacgap', root), {});

  const [fingerprintsFile] = await readdir(root);
  await writeFile(join(root, fingerprintsFile), '{invalid json');
  assert.deepEqual(readHostFingerprints('com.openai.codex', root), {});
});

test('target sessions persist learned host fingerprints immediately after injection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'attune-host-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const learned = { 'slack.composer': savedSlackComposerFingerprint['slack.composer'] };
  writeHostFingerprints('com.tinyspeck.slackmacgap', learned, root);
  const commands = [];
  const transport = {
    async send(method, params) {
      commands.push({ method, params });
      if (method === 'Runtime.evaluate' && params.expression.startsWith('(() => window.__attuneHost')) {
        return { result: { value: learned } };
      }
      return {};
    },
    close() {},
  };
  const session = new TargetStylesheetSession(transport, 'com.tinyspeck.slackmacgap', root);
  await session.sync(slackComposerSource, {}, 1_000);

  assert.deepEqual(readHostFingerprints('com.tinyspeck.slackmacgap', root), learned);
  assert.equal(commands.filter(command => command.method === 'Runtime.evaluate').length, 2);
  assert.match(commands.find(command => command.method === 'Runtime.evaluate').params.expression, /message-composer/);
});

test('stylesheet reads live source edits and falls back to the saved CSS', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'attune-config-'));
  const sourcePath = join(root, 'style.css');
  const configPath = join(root, 'config.json');

  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(sourcePath, 'body { color: teal; }');
  await writeFile(configPath, JSON.stringify({ css: 'body { color: black; }', sourcePath }));
  assert.equal(readStylesheet(configPath), 'body { color: teal; }');

  await writeFile(sourcePath, 'body { color: coral; }');
  assert.equal(readStylesheet(configPath), 'body { color: coral; }');

  await rm(sourcePath);
  assert.equal(readStylesheet(configPath), 'body { color: black; }');
});

test('scanner recognizes Electron, CEF, and Chrome app bundles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'attune-runtime-'));
  const electronPath = join(root, 'Electron.app');
  const cefPath = join(root, 'Spotify.app');
  const codexPath = join(root, 'ChatGPT.app');
  const chromePath = join(root, 'Google Chrome.app');

  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(electronPath, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  await mkdir(join(cefPath, 'Contents', 'Frameworks', 'Chromium Embedded Framework.framework'), { recursive: true });
  await mkdir(join(codexPath, 'Contents', 'Frameworks', 'Codex Framework.framework'), { recursive: true });
  await mkdir(join(chromePath, 'Contents', 'Frameworks', 'Google Chrome Framework.framework'), { recursive: true });

  assert.equal(getChromiumRuntime(electronPath), 'electron');
  assert.equal(getChromiumRuntime(cefPath), 'cef');
  assert.equal(getChromiumRuntime(codexPath), 'cef');
  assert.equal(getChromiumRuntime(chromePath), 'chrome');
  assert.equal(getChromiumRuntime(join(root, 'Notes.app')), null);
});
