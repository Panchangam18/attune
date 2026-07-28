import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = dirname(testRoot);
const mockCodex = join(testRoot, 'fixtures', 'mock-codex-app-server.mjs');
const mockClaude = join(testRoot, 'fixtures', 'mock-claude-stream.mjs');
const proxy = join(runtimeRoot, 'dist', 'claude-codex-proxy.js');

test('Claude proxy translates live text and tools into native Codex events', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-claude-proxy-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockClaude, 0o700)]);

  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CLI_PATH: mockClaude,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  const messages = [];
  const errors = [];
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  const lines = createInterface({ input: child.stdout });

  const completed = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for proxy turn.\n${errors.join('')}`,
    )), 10_000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 1) {
        send({
          id: 2,
          method: 'thread/start',
          params: {
            model: 'claude-fable',
            cwd: runtimeRoot,
            ephemeral: true,
          },
        });
      } else if (message.id === 2) {
        send({
          id: 3,
          method: 'turn/start',
          params: {
            threadId: message.result.thread.id,
            model: 'claude-fable',
            effort: 'low',
            input: [{
              type: 'text',
              text: 'Exercise the mock tool and stream the response.',
              text_elements: [],
            }],
          },
        });
      } else if (message.method === 'turn/completed') {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code && code !== 143) reject(new Error(
        `Proxy exited with ${code}.\n${errors.join('')}`,
      ));
    });
  });

  send({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'attune-proxy-test',
        title: 'Attune Proxy Test',
        version: '1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  });

  await completed;
  child.kill('SIGTERM');

  const deltas = messages
    .filter(message => message.method === 'item/agentMessage/delta')
    .map(message => message.params.delta);
  assert.deepEqual(deltas, ['LIVE_', 'DONE']);

  const startedItems = messages
    .filter(message => message.method === 'item/started')
    .map(message => message.params.item);
  assert.ok(startedItems.some(item => (
    item.type === 'mcpToolCall'
    && item.server === 'Claude Code'
    && item.tool === 'agent'
  )));
  assert.ok(startedItems.some(item => (
    item.type === 'commandExecution'
    && item.command === 'printf MOCK_TOOL_OK'
    && item.status === 'inProgress'
  )));

  const completedItems = messages
    .filter(message => message.method === 'item/completed')
    .map(message => message.params.item);
  assert.ok(completedItems.some(item => (
    item.type === 'commandExecution'
    && item.status === 'completed'
    && item.aggregatedOutput === 'MOCK_TOOL_OK'
  )));
  assert.ok(completedItems.some(item => (
    item.type === 'agentMessage'
    && item.phase === 'final_answer'
    && item.text === 'LIVE_DONE'
  )));

  const completedTurn = messages.find(message => message.method === 'turn/completed');
  assert.equal(completedTurn.params.turn.status, 'completed');
  assert.equal(errors.join(''), '');

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
});

test('Claude proxy interrupts an active stream and completes the turn cleanly', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-claude-interrupt-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockClaude, 0o700)]);

  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CLI_PATH: mockClaude,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));

  const messages = [];
  const errors = [];
  let sentInterrupt = false;
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  const lines = createInterface({ input: child.stdout });
  const completed = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for interrupted turn.\n${errors.join('')}`,
    )), 10_000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 11) {
        send({
          id: 12,
          method: 'thread/start',
          params: {
            model: 'claude-fable',
            cwd: runtimeRoot,
            ephemeral: true,
          },
        });
      } else if (message.id === 12) {
        send({
          id: 13,
          method: 'turn/start',
          params: {
            threadId: message.result.thread.id,
            model: 'claude-fable',
            effort: 'low',
            input: [{
              type: 'text',
              text: 'WAIT_FOR_INTERRUPT',
              text_elements: [],
            }],
          },
        });
      } else if (
        !sentInterrupt
        && message.method === 'item/started'
        && message.params.item.type === 'mcpToolCall'
        && message.params.item.tool === 'agent'
      ) {
        sentInterrupt = true;
        send({
          id: 14,
          method: 'turn/interrupt',
          params: { threadId: 'thread-attune-stream-test' },
        });
      } else if (message.method === 'turn/completed') {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once('error', reject);
  });

  send({
    id: 11,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'attune-proxy-interrupt-test',
        title: 'Attune Proxy Interrupt Test',
        version: '1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    },
  });

  await completed;
  child.kill('SIGTERM');

  assert.ok(messages.some(message => message.id === 14 && message.result));
  const completedTurn = messages.find(message => message.method === 'turn/completed');
  assert.equal(completedTurn.params.turn.status, 'interrupted');
  assert.equal(completedTurn.params.turn.error, null);
  assert.ok(messages.some(message => (
    message.method === 'item/completed'
    && message.params.item.type === 'mcpToolCall'
    && message.params.item.tool === 'agent'
    && message.params.item.status === 'failed'
  )));
  assert.equal(errors.join(''), '');

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
});
