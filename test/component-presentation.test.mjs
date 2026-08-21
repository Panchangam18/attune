import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildLiveComponentSlotFragment,
  buildComponentPresentationFragment,
  createLiveComponentPresentation,
  MAX_COMPONENT_VISUALIZATION_BYTES,
  writeComponentPresentation,
} from '../dist/component-presentation.js';
import { buildSemanticComponentAnchorExpression, buildSemanticComponentExpression } from '../dist/session.js';

function capture(imageBase64 = Buffer.from('component image').toString('base64')) {
  return {
    appId: 'com.example.app',
    appName: 'Example & App',
    role: 'example.composer',
    description: 'Message <composer>',
    capturedAt: '2026-08-18T12:00:00.000Z',
    width: 640,
    height: 120,
    imageMimeType: 'image/jpeg',
    imageBase64,
    resolution: { method: 'deterministic', confidence: 1, evidence: ['test'] },
  };
}

test('component presentation is a responsive self-contained HTML fragment', () => {
  const fragment = buildComponentPresentationFragment(capture());

  assert.match(fragment, /^<div id="attune-component-[a-f0-9]{12}"/);
  assert.match(fragment, /width: 100%; max-width: 640px/);
  assert.match(fragment, /data:image\/jpeg;base64,/);
  assert.match(fragment, /Example &amp; App: Message &lt;composer&gt;/);
  assert.doesNotMatch(fragment, /<!doctype|<html|<head|<body/i);
  assert.doesNotMatch(fragment, /fetch\(|XMLHttpRequest|WebSocket/);
});

test('writer returns the exact Codex visualization content reference', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attune-present-test-'));
  const outputPath = join(directory, 'component.html');
  try {
    const result = writeComponentPresentation(outputPath, capture());
    assert.equal(result.visualizationPath, outputPath);
    assert.equal(result.contentReference, `visualize{"path":${JSON.stringify(outputPath)}}`);
    assert.equal(result.static, true);
    assert.equal(result.bytes, statSync(outputPath).size);
    assert.equal(readFileSync(outputPath, 'utf8'), buildComponentPresentationFragment(capture()));
    assert.ok(result.bytes < MAX_COMPONENT_VISUALIZATION_BYTES);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writer enforces the inline visualization byte limit', () => {
  const oversized = Buffer.alloc(MAX_COMPONENT_VISUALIZATION_BYTES, 1).toString('base64');
  const directory = mkdtempSync(join(tmpdir(), 'attune-present-test-'));
  try {
    assert.throws(
      () => writeComponentPresentation(join(directory, 'component.html'), capture(oversized)),
      /inline visualizations must be under/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live presentation writes a networkless slot and private bridge request', () => {
  const directory = mkdtempSync(join(tmpdir(), 'attune-live-present-test-'));
  const brokerPath = join(directory, 'broker.json');
  const requestDirectory = join(directory, 'requests');
  const outputPath = join(directory, 'live-component.html');
  try {
    writeFileSync(brokerPath, JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString() }));
    const source = {
      appId: 'com.example.app', appName: 'Example', appPid: 123,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/source',
      anchor: {
        token: '87654321-4321-4432-a234-cba987654321',
        roles: ['example.composer'], selector: '[data-attune-host-roles~="example.composer"]',
        fingerprint: {
          tag: 'section', domRole: '', label: 'Composer', text: '', attributes: {}, classes: [], ancestor: null,
        },
        placement: 'inside',
      },
      description: 'Message composer', bounds: { x: 0, y: 0, width: 736, height: 120 },
    };
    const result = createLiveComponentPresentation(outputPath, source, { brokerPath, requestDirectory });
    const fragment = readFileSync(outputPath, 'utf8');
    const requests = readdirSync(requestDirectory);

    assert.equal(result.live, true);
    assert.equal(result.static, false);
    assert.match(fragment, new RegExp(`data-attune-smuggle-slot="attune-live-${result.requestId}"`));
    assert.match(fragment, /Connecting to Example/);
    assert.doesNotMatch(fragment, /fetch\(|XMLHttpRequest|WebSocket|data:image/);
    assert.equal(requests.length, 1);
    assert.equal(statSync(join(requestDirectory, requests[0])).mode & 0o777, 0o600);
    const queued = JSON.parse(readFileSync(join(requestDirectory, requests[0]), 'utf8'));
    assert.equal(queued.source.anchor.token, source.anchor.token);
    assert.equal(queued.target.slotId, `attune-live-${result.requestId}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('live slot fragment is responsive and self-contained', () => {
  const fragment = buildLiveComponentSlotFragment({
    slotId: 'attune-live-123', appName: 'Example', description: 'Composer', width: 736, height: 900,
  });
  assert.match(fragment, /max-width: 736px; min-height: 680px/);
  assert.match(fragment, /:has\(> attune-component-smuggle\)/);
  assert.doesNotMatch(fragment, /<!doctype|<html|<head|<body|70vh/i);
});

test('semantic component expression resolves and clips one visible role', () => {
  const element = {
    getBoundingClientRect: () => ({ left: -12, top: 20, right: 700, bottom: 180 }),
  };
  const mapper = {
    request: () => ({ capabilities: {
      'example.composer': { method: 'fingerprint', confidence: 0.91, evidence: ['label'] },
    } }),
    resolve: role => role === 'example.composer' ? element : null,
    fingerprints: () => ({ 'example.composer': { tag: 'form' } }),
  };
  const result = vm.runInNewContext(buildSemanticComponentExpression(
    'example.composer',
    { 'example.composer': { app: 'Example', description: 'Message composer' } },
  ), {
    window: { __attuneHost: mapper },
    document: { title: 'Example' },
    innerWidth: 640,
    innerHeight: 480,
    devicePixelRatio: 2,
    getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1' }),
  });

  assert.equal(result.role, 'example.composer');
  assert.deepEqual({ ...result.bounds }, { x: 0, y: 20, width: 640, height: 160 });
  assert.equal(result.resolution.method, 'fingerprint');
  assert.equal(result.resolution.confidence, 0.91);
});

test('semantic component anchor expression retains the resolved source', () => {
  const attributes = new Map();
  const parentElement = {
    tagName: 'MAIN',
    getAttribute: name => name === 'role' ? 'main' : '',
  };
  const element = {
    tagName: 'SECTION',
    innerText: 'Draft message',
    textContent: 'Draft message',
    classList: ['composer', 'stable'],
    parentElement,
    getBoundingClientRect: () => ({ left: 20, top: 30, right: 420, bottom: 150 }),
    getAttribute: name => ({ role: 'form', 'aria-label': 'Composer', 'data-testid': 'composer' })[name] || '',
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const mapper = {
    request: () => ({ capabilities: {
      'example.composer': { method: 'deterministic', confidence: 0.98, evidence: ['test id'] },
    } }),
    resolve: role => role === 'example.composer' ? element : null,
    fingerprints: () => ({}),
  };
  const context = {
    window: { __attuneHost: mapper },
    document: { title: 'Example' },
    innerWidth: 640,
    innerHeight: 480,
    devicePixelRatio: 2,
    getComputedStyle: () => ({ display: 'flex', visibility: 'visible', opacity: '1' }),
  };
  const token = '87654321-4321-4432-a234-cba987654321';
  const result = vm.runInNewContext(buildSemanticComponentAnchorExpression(
    'example.composer',
    token,
    { 'example.composer': { app: 'Example', description: 'Message composer' } },
  ), context);

  assert.equal(context.window.__attuneSmuggleAnchors[token], element);
  assert.equal(attributes.get('data-attune-smuggle-anchor'), token);
  assert.equal(result.fingerprint.tag, 'section');
  assert.equal(result.fingerprint.attributes['data-testid'], 'composer');
  assert.equal(result.fingerprint.ancestor.domRole, 'main');
});
