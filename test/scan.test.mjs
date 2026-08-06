import assert from 'node:assert/strict';
import test from 'node:test';

import { deduplicateAppsByBundleId } from '../dist/scan.js';

test('app discovery deduplicates bundle IDs and prefers the first search root', () => {
  const systemClaude = {
    name: 'Claude',
    path: '/Applications/Claude.app',
    bundleId: 'com.anthropic.claudefordesktop',
    runtime: 'electron',
  };
  const userClaude = {
    ...systemClaude,
    path: '/Users/example/Applications/Claude.app',
  };
  const appWithoutBundleId = {
    name: 'Local App',
    path: '/Applications/Local App.app',
    bundleId: null,
    runtime: 'electron',
  };

  assert.deepEqual(
    deduplicateAppsByBundleId([systemClaude, userClaude, appWithoutBundleId]),
    [systemClaude, appWithoutBundleId],
  );
});

test('apps without bundle IDs are not accidentally deduplicated', () => {
  const first = {
    name: 'Local App',
    path: '/Applications/Local App.app',
    bundleId: null,
    runtime: 'electron',
  };
  const second = {
    ...first,
    path: '/Users/example/Applications/Local App.app',
  };

  assert.deepEqual(deduplicateAppsByBundleId([first, second]), [first, second]);
});
