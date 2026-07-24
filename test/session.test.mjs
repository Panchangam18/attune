import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { readStylesheet } from '../dist/config.js';
import { getChromiumRuntime } from '../dist/scan.js';
import { buildInspectionExpression, buildStyleInjectionExpression, compactInspection, splitWorkspaceSource } from '../dist/session.js';

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
  });
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(source), { document, window, console }), 'applied');
  assert.equal(styles.get('attune-custom-stylesheet').textContent, 'body { color: teal; }');
  assert.equal(window.__attuneScriptRuns, 1);
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(source), { document, window, console }), 'current');
  assert.equal(window.__attuneScriptRuns, 1);
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression('body { color: plum; }'), { document, window, console }), 'applied');
  assert.equal(window.__attuneScriptCleanups, 1);
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
