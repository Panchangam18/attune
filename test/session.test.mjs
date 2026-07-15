import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { readStylesheet } from '../dist/config.js';
import { buildStyleInjectionExpression } from '../dist/session.js';

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

  assert.equal(vm.runInNewContext(expression, { document }), 'applied');
  assert.equal(styles.get('attune-custom-stylesheet').textContent, css);
  assert.equal(vm.runInNewContext(expression, { document }), 'current');
  assert.equal(vm.runInNewContext(buildStyleInjectionExpression(''), { document }), 'removed');
  assert.equal(styles.size, 0);
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
