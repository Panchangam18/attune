#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
const threads = new Map();
const pendingToolTurns = new Map();
let nextThread = 1;

lines.on('line', line => {
  const message = JSON.parse(line);
  log(message);

  if (message.method === 'initialize') {
    reply(message.id, { userAgent: 'mock-attune-codex' });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    reply(message.id, process.env.ATTUNE_MOCK_CODEX_AUTH_MISSING === '1'
      ? { account: null, requiresOpenaiAuth: true }
      : {
        account: { type: 'chatgpt', planType: 'pro' },
        requiresOpenaiAuth: true,
      });
    return;
  }
  if (message.method === 'model/list') {
    reply(message.id, {
      data: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => ({ id })),
      nextCursor: null,
    });
    return;
  }
  if (message.method === 'thread/start') {
    const threadId = `mock-thread-${nextThread++}`;
    threads.set(threadId, {
      dynamicTools: message.params?.dynamicTools ?? [],
    });
    reply(message.id, {
      thread: { id: threadId, sessionId: threadId, ephemeral: true },
    });
    notify('thread/started', { thread: { id: threadId } });
    return;
  }
  if (message.method === 'turn/start') {
    const threadId = message.params?.threadId;
    const turnId = `mock-turn-${threadId}`;
    reply(message.id, {
      turn: { id: turnId, status: 'inProgress', items: [], error: null },
    });
    notify('turn/started', {
      threadId,
      turn: { id: turnId, status: 'inProgress', items: [], error: null },
    });
    const prompt = message.params?.input?.[0]?.text ?? '';
    const dynamicTool = threads.get(threadId)?.dynamicTools?.[0];
    if (prompt.includes('please use tool') && dynamicTool) {
      const requestId = 90_000 + nextThread;
      pendingToolTurns.set(String(requestId), { threadId, turnId });
      notify('item/started', {
        threadId,
        turnId,
        item: {
          type: 'dynamicToolCall',
          id: 'mock-dynamic-tool',
          tool: dynamicTool.name,
          arguments: { path: 'README.md' },
          status: 'inProgress',
        },
      });
      process.stdout.write(`${JSON.stringify({
        id: requestId,
        method: 'item/tool/call',
        params: {
          threadId,
          turnId,
          callId: 'call_mock_read',
          namespace: null,
          tool: dynamicTool.name,
          arguments: { path: 'README.md' },
        },
      })}\n`);
      return;
    }
    setImmediate(() => {
      notify('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: 'mock-answer',
        delta: 'GPT_BRIDGE_OK',
      });
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          type: 'agentMessage',
          id: 'mock-answer',
          text: 'GPT_BRIDGE_OK',
          phase: 'final_answer',
        },
      });
      notify('turn/completed', {
        threadId,
        turn: {
          id: turnId,
          status: 'completed',
          items: [],
          error: null,
        },
      });
    });
    return;
  }
  if (message.method === 'turn/interrupt') {
    reply(message.id, {});
    setImmediate(() => notify('turn/completed', {
      threadId: message.params?.threadId,
      turn: {
        id: message.params?.turnId,
        status: 'interrupted',
        items: [],
        error: null,
      },
    }));
    return;
  }
  if (message.method === 'thread/unsubscribe') {
    reply(message.id, { status: 'unsubscribed' });
    return;
  }
  if (message.id !== undefined && pendingToolTurns.has(String(message.id))) {
    pendingToolTurns.delete(String(message.id));
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
});

function reply(id, result) {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}

function log(message) {
  const path = process.env.ATTUNE_MOCK_CODEX_LOG_PATH;
  if (!path) return;
  const safe = {
    method: message.method ?? null,
    hasDynamicTools: Array.isArray(message.params?.dynamicTools)
      && message.params.dynamicTools.length > 0,
    ephemeral: message.params?.ephemeral ?? null,
    model: message.params?.model ?? null,
    hasBaseInstructions: typeof message.params?.baseInstructions === 'string',
  };
  appendFileSync(path, `${JSON.stringify(safe)}\n`);
}
