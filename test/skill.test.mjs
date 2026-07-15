import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('agent skill has complete metadata and safety boundaries', () => {
  const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');

  assert.match(skill, /^---\nname: attune\ndescription: .+\n---/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(skill, /Never edit `app\.asar`/);
  assert.match(skill, /Ask for explicit consent before closing a running app/);
  assert.match(skill, /attune status/);
  assert.match(skill, /Native apps such as Notes/);
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
  assert.match(openaiMetadata, /Use \$attune to restyle/);
});
