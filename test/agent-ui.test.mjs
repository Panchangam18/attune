import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentStyleSource,
  extractSemanticRoles,
  getRoleCatalogForApp,
} from '../dist/agent-ui.js';
import { splitWorkspaceSource } from '../dist/session.js';

test('agent CSS persists exactly the semantic roles it references', () => {
  const css = `
[data-attune-host-roles~="slack.composer"] { border-radius: 12px; }
[data-attune-host-roles~='slack.sendButton'] { color: white; }
[data-attune-host-roles~="slack.composer"]:focus { outline: 2px solid blue; }
`;
  assert.deepEqual(extractSemanticRoles(css), ['slack.composer', 'slack.sendButton']);

  const style = buildAgentStyleSource('com.tinyspeck.slackmacgap', 'Slack', css);
  const parsed = splitWorkspaceSource(style.source);
  assert.equal(parsed.css, css.trim());
  assert.deepEqual(parsed.bindingSets[0].bindings.map(binding => binding.role), [
    'slack.composer',
    'slack.sendButton',
  ]);
  assert.equal(parsed.bindingSets[0].schemaVersion, 2);
});

test('agent CSS rejects invented semantic roles', () => {
  assert.throws(() => buildAgentStyleSource(
    'com.example',
    'Example',
    '[data-attune-host-roles~="example.guessed"] { color: red; }',
  ), /Unknown Attune semantic role: example\.guessed/);
});

test('ChatGPT semantic catalog includes both ChatGPT and Codex host surfaces', () => {
  const catalog = getRoleCatalogForApp('ChatGPT', 'com.openai.codex');
  assert.ok(catalog['document.body']);
  assert.ok(catalog['chatgpt.composer']);
  assert.ok(catalog['codex.primaryChat']);
  assert.equal(catalog['slack.composer'], undefined);
});

test('Visual Studio Code reuses the compatible editor workbench roles', () => {
  const catalog = getRoleCatalogForApp('Visual Studio Code', 'com.microsoft.VSCode');
  assert.ok(catalog['cursor.workbench']);
  assert.ok(catalog['cursor.titlebar']);
});
