#!/usr/bin/env node

process.env.ATTUNE_MOCK_CODEX_AUTH_MISSING = '1';
await import('./mock-claude-codex-bridge.mjs');
