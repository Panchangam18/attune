#!/usr/bin/env node

import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });

lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(message.id, {
      userAgent: 'mock-codex',
    });
    return;
  }
  if (message.method === 'model/list') {
    reply(message.id, { data: [] });
    return;
  }
  if (message.method === 'thread/start') {
    reply(message.id, {
      thread: {
        id: 'thread-attune-stream-test',
        turns: [],
      },
      model: message.params?.model ?? 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      serviceTier: 'default',
      cwd: message.params?.cwd ?? process.cwd(),
    });
    return;
  }
  reply(message.id, {});
});

function reply(id, result) {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
