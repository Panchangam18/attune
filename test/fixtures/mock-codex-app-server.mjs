#!/usr/bin/env node

import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
let lastTurnModel = null;
const turns = [];

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
    lastTurnModel = message.params?.model ?? 'gpt-5.6-terra';
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
  if (message.method === 'thread/turns/list') {
    reply(message.id, { data: turns });
    return;
  }
  if (message.method === 'turn/start') {
    const nextModel = message.params?.model ?? 'gpt-5.6-terra';
    const modelChanged = {
      type: 'modelChanged',
      id: 'mock-model-change',
      fromModel: lastTurnModel,
      toModel: nextModel,
    };
    const assistant = {
      type: 'agentMessage',
      id: 'mock-native-answer',
      text: 'NATIVE_DONE',
      phase: 'final_answer',
      memoryCitation: null,
    };
    const turn = {
      id: 'mock-native-turn',
      items: [modelChanged, assistant],
      itemsView: 'summary',
      status: 'completed',
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
    };
    turns.push(turn);
    lastTurnModel = nextModel;
    reply(message.id, { turn });
    return;
  }
  reply(message.id, {});
});

function reply(id, result) {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
