import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRoutingDiagnostics,
  routingErrorCode,
} from '../dist/claude-gpt-diagnostics.js';

test('writes private JSONL routing metadata without sensitive fields', async t => {
  const root = await mkdtemp('/tmp/attune-routing-diagnostics-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'private', 'routing.jsonl');
  const diagnostics = createRoutingDiagnostics(path);

  diagnostics.write('router', 'request\naccepted', {
    requestId: 'request-123',
    route: 'gpt',
    durationMs: 17,
    streamEvents: ['message_start', 'message_stop'],
    authorization: 'Bearer never-write-this',
    accessToken: 'never-write-this-either',
    gatewayKey: 'nor-this',
    requestBody: 'private prompt',
    content: 'private response',
  });
  await diagnostics.flush();

  const raw = await readFile(path, 'utf8');
  const record = JSON.parse(raw.trim());
  assert.equal(record.component, 'router');
  assert.equal(record.event, 'request accepted');
  assert.equal(record.requestId, 'request-123');
  assert.equal(record.route, 'gpt');
  assert.equal(record.durationMs, 17);
  assert.deepEqual(record.streamEvents, ['message_start', 'message_stop']);
  assert.doesNotMatch(raw, /never-write|private prompt|private response|authorization|accessToken|gatewayKey|requestBody|content/);
  assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('normalizes diagnostic error codes without including error messages', () => {
  assert.equal(routingErrorCode({ code: 'ECONNRESET', message: 'contains private data' }), 'ECONNRESET');
  assert.equal(routingErrorCode(new TypeError('contains private data')), 'TypeError');
  assert.equal(routingErrorCode({ code: 'bad value with spaces' }), 'unknown');
});
