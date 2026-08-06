import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { readStylesheet } from '../dist/config.js';
import { getChromiumRuntime } from '../dist/scan.js';
import {
  buildInspectionExpression,
  buildStyleInjectionExpression,
  compactInspection,
  resolveClaudeCliPath,
  shouldEnableClaudeCodexProxy,
  splitWorkspaceSource,
  TargetStylesheetSession,
} from '../dist/session.js';

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
{"schemaVersion":1,"attunementId":"codex-multi-chat","appName":"Codex","bindings":[{"name":"main","role":"codex.primaryChat","required":true},{"name":"header","role":"codex.chatHeader","required":false}]}
@end-attune-bindings */

[data-attune-host-roles~="codex.primaryChat"] { display: flex; }

/* @attune-script
window.__mappedBeforeScript = Boolean(window.__attuneHost?.resolve('codex.primaryChat'));
@end-attune-script */`;
  const attributes = new Map();
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
      if (selector === '[data-codex-composer-root]') return {};
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
  assert.equal(attributes.get('header:data-attune-host-roles'), 'codex.chatHeader');
  assert.equal(window.__attuneCompatibilityReports['codex-multi-chat'].status, 'compatible');
});

test('host mapper publishes semantic strategies for every supported attunement surface', () => {
  const expression = buildStyleInjectionExpression('body { color: CanvasText; }');
  for (const role of [
    'codex.appShell',
    'codex.sidebarThreads',
    'codex.modelPicker',
    'chatgpt.conversation',
    'chatgpt.composer',
    'chatgpt.attachmentMenu',
    'linear.workspace',
    'linear.issueList',
    'linear.issueDetail',
    'linear.statusControl',
    'slack.workspace',
    'slack.composer',
    'slack.sendButton',
    'cursor.workbench',
    'cursor.titlebar',
    'youtube.player',
  ]) {
    assert.match(expression, new RegExp(role.replace('.', '\\.')));
  }
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

test('scanner recognizes Electron and Chromium Embedded Framework app bundles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'attune-runtime-'));
  const electronPath = join(root, 'Electron.app');
  const cefPath = join(root, 'Spotify.app');
  const codexPath = join(root, 'ChatGPT.app');

  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(electronPath, 'Contents', 'Frameworks', 'Electron Framework.framework'), { recursive: true });
  await mkdir(join(cefPath, 'Contents', 'Frameworks', 'Chromium Embedded Framework.framework'), { recursive: true });
  await mkdir(join(codexPath, 'Contents', 'Frameworks', 'Codex Framework.framework'), { recursive: true });

  assert.equal(getChromiumRuntime(electronPath), 'electron');
  assert.equal(getChromiumRuntime(cefPath), 'cef');
  assert.equal(getChromiumRuntime(codexPath), 'cef');
  assert.equal(getChromiumRuntime(join(root, 'Notes.app')), null);
});
