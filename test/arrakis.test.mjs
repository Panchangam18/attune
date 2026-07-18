import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
test('Arrakis generates standalone stylesheets for every declared adapter', async () => {
  await run(process.execPath, ['scripts/build-themes.mjs', 'arrakis'], { cwd: root });

  const manifest = JSON.parse(await readFile(join(root, 'themes', 'arrakis', 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.adapters), [
    'Spotify',
    'Slack',
    'Visual Studio Code',
    'Claude',
    'ChatGPT',
  ]);
  assert.equal(manifest.adapters.Spotify.canvas, 'dark');
  assert.equal(manifest.adapters.Slack.canvas, 'dark');
  assert.equal(manifest.adapters['Visual Studio Code'].canvas, 'dark');
  assert.equal(manifest.adapters.Claude.canvas, 'light');
  assert.equal(manifest.adapters.ChatGPT.canvas, 'light');

  for (const [appName, adapter] of Object.entries(manifest.adapters)) {
    const adapterSource = await readFile(join(root, adapter.source), 'utf8');
    const stylesheet = await readFile(join(root, adapter.output), 'utf8');
    assert.match(stylesheet, /Generated from themes\/arrakis/);
    assert.match(stylesheet, /--arr-sand/);
    assert.match(stylesheet, /--arr-spice/);
    assert.match(stylesheet, /#b7a77d/i);
    assert.match(stylesheet, /#15140f/i);
    assert.match(stylesheet, /#aa5042/i);
    assert.match(stylesheet, /--arr-font-ui: "Nasalization"/);
    assert.match(stylesheet, /--arr-font-display: var\(--arr-font-ui\)/);
    assert.match(stylesheet, /--arr-font-meta: var\(--arr-font-ui\)/);
    assert.match(stylesheet, /@font-face\s*\{[\s\S]*?font-family:\s*"Nasalization";[\s\S]*?data:font\/otf;base64,/);
    assert.match(stylesheet, /body \*:not\(.codicon\)/);
    const fontFamilyDeclarations = stylesheet.match(/font-family\s*:\s*[^;]+;/gi) ?? [];
    for (const declaration of fontFamilyDeclarations) {
      assert.match(declaration, /(?:"Nasalization"|var\(--arr-font-(?:ui|display|meta)\))/);
    }

    const directColorDeclarations = adapterSource.match(
      /(?:^|[;{])\s*[-\w]+\s*:\s*(?:#[0-9a-f]{3,8}|rgba?\()/gim,
    );
    assert.equal(
      directColorDeclarations?.length ?? 0,
      0,
      `${appName} should use shared Arrakis tokens for color declarations`,
    );

    if (appName === 'Slack') {
      assert.match(stylesheet, /\.p-theme_background/);
      assert.match(stylesheet, /\.p-ia4_top_nav/);
      assert.match(stylesheet, /\.c-wysiwyg_container--theme_dark/);
    }

    if (appName === 'Spotify') {
      assert.match(stylesheet, /\[data-testid="play-button"\][\s\S]*?opacity: 0/);
      assert.match(stylesheet, /\.e-10451-card:hover \[data-testid="play-button"\]/);
      assert.match(stylesheet, /\[data-testid="control-button-playpause"\][\s\S]*?var\(--arr-terracotta\)/);
      assert.match(stylesheet, /control-button-playpause.*e-10451-button-primary__inner/);
      assert.doesNotMatch(stylesheet, /\[data-encore-id="buttonPrimary"\]\s*\{\s*background:/);
      assert.doesNotMatch(stylesheet, /#1ed760/i);
    }

    if (appName === 'Visual Studio Code') {
      assert.match(stylesheet, /--vscode-editorWidget-background/);
      assert.match(stylesheet, /\.monaco-workbench \.monaco-list-rows/);
      assert.match(stylesheet, /\.monaco-workbench \.editor-container/);
    }
  }
});
