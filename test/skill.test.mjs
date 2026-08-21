import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('agent skill has complete metadata and safety boundaries', () => {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');

  assert.match(skill, /^---\nname: attune\ndescription: .+\n---/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(skill, /attune elements "App Name"/);
  assert.match(skill, /attune style "App Name" --css/);
  assert.match(skill, /attune present "App Name" --role app\.role --output .* --live/);
  assert.match(skill, /returned `contentReference` exactly once/);
  assert.match(skill, /pointer, keyboard, editing, and scrolling bridge/);
  assert.match(skill, /static screenshot fallback/);
  assert.match(skill, /host supports inline visualization content references/);
  assert.match(skill, /attune present "Safari" --selector/);
  assert.match(skill, /Do not accept or execute page JavaScript/);
  assert.match(skill, /exactly two calls/);
  assert.match(skill, /one call/);
  assert.match(skill, /Do not prepend `scan`, `status`, `roles`, or `inspect`/);
  assert.match(skill, /Never edit `app\.asar`/);
  assert.match(skill, /explicit consent before closing or relaunching/);
  assert.match(skill, /Chromium Embedded Framework/);
  assert.match(skill, /Native macOS apps such as Notes/);
  assert.match(skill, /Command separation/);
});

test('skill package includes agent metadata and examples', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const openaiMetadata = readFileSync(join(root, 'agents', 'openai.yaml'), 'utf8');

  assert.deepEqual(packageJson.engines, { node: '>=22' });
  assert.ok(packageJson.files.includes('SKILL.md'));
  assert.ok(packageJson.files.includes('agents'));
  assert.ok(packageJson.files.includes('examples'));
  assert.equal(packageJson.dependencies, undefined);
  assert.match(openaiMetadata, /display_name: "Attune"/);
  assert.match(openaiMetadata, /Use \$attune to restyle an open Chromium desktop app or smuggle one interactive semantic component inline/);
});
