import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = dirname(testRoot);
const mockCodex = join(testRoot, 'fixtures', 'mock-codex-app-server.mjs');
const mockClaude = join(testRoot, 'fixtures', 'mock-claude-stream.mjs');
const mockExternalAgent = join(testRoot, 'fixtures', 'mock-external-agent-stream.mjs');
const proxy = join(runtimeRoot, 'dist', 'claude-codex-proxy.js');

test('Claude proxy translates live text and tools into native Codex events', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-claude-proxy-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockClaude, 0o700)]);

  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CLI_PATH: mockClaude,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
      ATTUNE_COPILOT_MODELS_JSON: JSON.stringify([{ id: 'gpt-5.4', name: 'GPT-5.4' }]),
      ATTUNE_CURSOR_MODELS_JSON: JSON.stringify([{ id: 'gpt-5.4', name: 'GPT-5.4' }]),
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
        send({ id: 4, method: 'model/list', params: {} });
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
  const modelList = messages.find(message => message.id === 4);
  assert.deepEqual(
    modelList.result.data.filter(model => !model.hidden).map(model => model.id),
    ['claude-fable', 'claude-opus', 'grok-4.5', 'cursor-agent', 'copilot-agent'],
  );
  assert.deepEqual(
    modelList.result.data.filter(model => model.hidden).map(model => model.id),
    ['cursor-agent::gpt-5.4', 'copilot-agent::gpt-5.4'],
  );
  assert.deepEqual(
    modelList.result.data.filter(model => model.hidden).map(model => model.displayName),
    ['Cursor · GPT-5.4', 'Copilot · GPT-5.4'],
  );
  assert.deepEqual(
    modelList.result.data.find(model => model.id === 'cursor-agent')
      .attuneNestedModels.map(model => model.id),
    ['cursor-agent', 'cursor-agent::gpt-5.4'],
  );
  assert.deepEqual(
    modelList.result.data.find(model => model.id === 'copilot-agent')
      .attuneNestedModels.map(model => model.id),
    ['copilot-agent', 'copilot-agent::gpt-5.4'],
  );
  assert.equal(
    modelList.result.data.find(model => model.id === 'cursor-agent')
      .attuneSupportsPendingNewThreadSelection,
    true,
  );
  assert.equal(
    modelList.result.data.find(model => model.id === 'copilot-agent')
      .attuneSupportsPendingNewThreadSelection,
    true,
  );

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
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
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

test('free Cursor accounts expose the full catalog with only Auto selectable', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-cursor-catalog-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockExternalAgent, 0o700)]);
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
      ATTUNE_COPILOT_CLI_PATH: mockExternalAgent,
      ATTUNE_CURSOR_CLI_PATH: mockExternalAgent,
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const errors = [];
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  const lines = createInterface({ input: child.stdout });
  const modelList = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for the Cursor catalog.\n${errors.join('')}`,
    )), 10_000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === 61) {
        child.stdin.write(`${JSON.stringify({
          id: 62,
          method: 'model/list',
          params: {},
        })}\n`);
      } else if (message.id === 62) {
        clearTimeout(timer);
        resolvePromise(message);
      }
    });
    child.once('error', reject);
    child.stdin.write(`${JSON.stringify({
      id: 61,
      method: 'initialize',
      params: {},
    })}\n`);
  });
  child.kill('SIGTERM');

  const cursorModels = modelList.result.data.find(
    model => model.id === 'cursor-agent',
  ).attuneNestedModels;
  assert.deepEqual(
    cursorModels.map(model => model.displayName),
    ['Auto', 'GPT-5.4', 'Sonnet 5'],
  );
  assert.deepEqual(
    cursorModels.map(model => model.attuneSelectable),
    [true, false, false],
  );
  assert.deepEqual(
    cursorModels.map(model => model.attuneUnavailableReason),
    [null, 'Requires a paid Cursor plan.', 'Requires a paid Cursor plan.'],
  );
  assert.equal(errors.join(''), '');
});

test('native model-change history names the external model that actually ran', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-model-change-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockExternalAgent, 0o700)]);
  const argsLogPath = join(stateRoot, 'external-args.jsonl');
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
      ATTUNE_CURSOR_MODELS_JSON: JSON.stringify([{ id: 'gpt-5.2', name: 'GPT-5.2' }]),
      ATTUNE_EXTERNAL_AGENT_ARGS_LOG: argsLogPath,
      ATTUNE_GROK_CLI_PATH: mockExternalAgent,
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const messages = [];
  const errors = [];
  child.stderr.on('data', chunk => errors.push(String(chunk)));
  const lines = createInterface({ input: child.stdout });

  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for model-change history.\n${errors.join('')}`,
    )), 10_000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 71) {
        send({
          id: 72,
          method: 'thread/start',
          params: { model: 'gpt-native-old', cwd: runtimeRoot },
        });
      } else if (message.id === 72) {
        send({
          id: 73,
          method: 'thread/settings/update',
          params: {
            threadId: message.result.thread.id,
            model: 'cursor-agent::gpt-5.2',
            effort: 'medium',
            attuneExternalSelection: true,
          },
        });
      } else if (message.id === 73) {
        send({
          id: 74,
          method: 'thread/settings/update',
          params: {
            threadId: 'thread-attune-stream-test',
            model: 'gpt-native-new',
            effort: 'medium',
          },
        });
      } else if (message.id === 74) {
        send({
          id: 75,
          method: 'turn/start',
          params: {
            threadId: 'thread-attune-stream-test',
            model: 'gpt-native-new',
            effort: 'medium',
            input: [{ type: 'text', text: 'Continue natively.', text_elements: [] }],
          },
        });
      } else if (message.id === 75) {
        send({
          id: 76,
          method: 'thread/turns/list',
          params: {
            threadId: 'thread-attune-stream-test',
            cursor: null,
            sortDirection: 'ascending',
          },
        });
      } else if (message.id === 76) {
        send({
          id: 77,
          method: 'thread/settings/update',
          params: {
            threadId: 'thread-attune-stream-test',
            model: 'grok-4.5',
            effort: 'high',
            attuneExternalSelection: true,
          },
        });
      } else if (message.id === 77) {
        send({
          id: 78,
          method: 'turn/start',
          params: {
            threadId: 'thread-attune-stream-test',
            model: 'grok-4.5',
            effort: 'high',
            input: [{ type: 'text', text: 'Recall the native turn.', text_elements: [] }],
          },
        });
      } else if (message.method === 'turn/completed') {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once('error', reject);
    send({ id: 71, method: 'initialize', params: {} });
  });
  child.kill('SIGTERM');

  assert.equal(
    messages.find(message => message.id === 75)
      .result.turn.items[0].fromModel,
    'cursor-agent::gpt-5.2',
  );
  assert.equal(
    messages.find(message => message.id === 76)
      .result.data[0].items[0].fromModel,
    'cursor-agent::gpt-5.2',
  );
  const grokSettings = messages.find(message => (
    message.method === 'thread/settings/updated'
    && message.params.threadSettings.collaborationMode.settings.model === 'grok-4.5'
  ));
  assert.equal(grokSettings.params.threadSettings.model, 'grok-4.5');
  assert.equal(
    grokSettings.params.threadSettings.collaborationMode.settings.model,
    'grok-4.5',
  );
  const grokInvocation = JSON.parse((await readFile(argsLogPath, 'utf8')).trim());
  const grokPrompt = grokInvocation[grokInvocation.indexOf('-p') + 1];
  assert.match(grokPrompt, /User: Continue natively\./);
  assert.match(grokPrompt, /Assistant \(GPT Native New\): NATIVE_DONE/);
  assert.match(grokPrompt, /Current user request:\nRecall the native turn\./);
  assert.equal(errors.join(''), '');

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
});

for (const [model, expectedText] of [
  ['grok-4.5', 'GROK_DONE'],
  ['cursor-agent', 'CURSOR_DONE'],
  ['copilot-agent', 'COPILOT_DONE'],
  ['cursor-agent::gpt-5.4', 'CURSOR_DONE'],
  ['copilot-agent::gpt-5.4', 'COPILOT_DONE'],
]) {
  test(`${model} streams seamlessly through native Codex turn events`, async (t) => {
    const stateRoot = await mkdtemp(join(tmpdir(), `attune-${model}-proxy-test-`));
    t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    await Promise.all([chmod(mockCodex, 0o700), chmod(mockExternalAgent, 0o700)]);
    const child = spawn(process.execPath, [proxy, 'app-server'], {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        ATTUNE_GROK_CLI_PATH: mockExternalAgent,
        ATTUNE_CURSOR_CLI_PATH: mockExternalAgent,
        ATTUNE_COPILOT_CLI_PATH: mockExternalAgent,
        ATTUNE_COPILOT_MODELS_JSON: JSON.stringify(['gpt-5.4']),
        ATTUNE_CLAUDE_CODEX_STATE_PATH: join(stateRoot, 'state.json'),
        ATTUNE_CURSOR_MODELS_JSON: JSON.stringify(['gpt-5.4']),
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
        `Timed out waiting for ${model} turn.\n${errors.join('')}`,
      )), 10_000);
      lines.on('line', line => {
        const message = JSON.parse(line);
        messages.push(message);
        if (message.id === 21) {
          send({
            id: 22,
            method: 'thread/start',
            params: { model, effort: 'high', cwd: runtimeRoot },
          });
        } else if (message.id === 22) {
          send({
            id: 23,
            method: 'turn/start',
            params: {
              threadId: message.result.thread.id,
              // Echo the native-facing parent model exactly as ChatGPT does.
              // The proxy must retain any nested provider model in its sidecar.
              model: message.result.model,
              effort: 'high',
              input: [{ type: 'text', text: 'Stream a provider response.', text_elements: [] }],
            },
          });
        } else if (message.method === 'turn/completed') {
          clearTimeout(timer);
          resolvePromise();
        }
      });
      child.once('error', reject);
    });
    send({ id: 21, method: 'initialize', params: {} });
    await completed;
    child.kill('SIGTERM');

    assert.equal(
      messages.find(message => message.id === 22).result.model,
      model.startsWith('cursor-agent::')
        ? 'cursor-agent'
        : model.startsWith('copilot-agent::')
          ? 'copilot-agent'
          : model,
    );
    assert.equal(
      messages
        .filter(message => message.method === 'item/agentMessage/delta')
        .map(message => message.params.delta)
        .join(''),
      expectedText,
    );
    assert.equal(
      messages.find(message => message.method === 'turn/completed').params.turn.status,
      'completed',
    );
    assert.equal(errors.join(''), '');

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

test('external providers keep isolated sessions and pending placeholder selections win stale turns', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-provider-session-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await Promise.all([chmod(mockCodex, 0o700), chmod(mockExternalAgent, 0o700)]);
  const statePath = join(stateRoot, 'state.json');
  const argsLogPath = join(stateRoot, 'external-args.jsonl');
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_GROK_CLI_PATH: mockExternalAgent,
      ATTUNE_CURSOR_CLI_PATH: mockExternalAgent,
      ATTUNE_COPILOT_CLI_PATH: mockExternalAgent,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: statePath,
      ATTUNE_EXTERNAL_AGENT_ARGS_LOG: argsLogPath,
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const messages = [];
  let completedTurns = 0;
  let threadId = '';
  const lines = createInterface({ input: child.stdout });

  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out testing provider session isolation.')),
      10_000,
    );
    lines.on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 41) {
        send({
          id: 42,
          method: 'thread/start',
          params: { model: 'cursor-agent', cwd: runtimeRoot },
        });
      } else if (message.id === 42) {
        threadId = message.result.thread.id;
        startTurn(43, 'cursor-agent');
      } else if (message.id === 44) {
        startTurn(45, 'grok-4.5');
      } else if (message.id === 46) {
        // Simulate ChatGPT's delayed native parent echo after Attune selected
        // a nested Copilot model. It must not overwrite the nested selection.
        send({
          id: 47,
          method: 'thread/settings/update',
          params: { threadId, model: 'copilot-agent', effort: 'high' },
        });
      } else if (message.id === 47) {
        // The UI can echo its previously selected top-level model into the
        // next turn. The committed proxy state must remain the sole authority.
        startTurn(48, 'claude-fable');
      } else if (message.id === 49) {
        startTurn(50, 'copilot-agent');
      } else if (message.id === 51) {
        // ChatGPT can expose client-new-thread in the UI while sending the next
        // turn to an existing UUID with its previous native model.
        startTurn(52, 'claude-fable');
      } else if (message.method === 'turn/completed') {
        completedTurns += 1;
        if (completedTurns === 1) {
          send({
            id: 44,
            method: 'thread/settings/update',
            params: {
              threadId,
              model: 'grok-4.5',
              effort: 'high',
              attuneExternalSelection: true,
            },
          });
        } else if (completedTurns === 2) {
          send({
            id: 46,
            method: 'thread/settings/update',
            params: {
              threadId,
              model: 'copilot-agent::gpt-5.4',
              effort: 'high',
              attuneExternalSelection: true,
            },
          });
        } else if (completedTurns === 3) {
          send({
            id: 49,
            method: 'thread/settings/update',
            params: {
              threadId,
              model: 'cursor-agent',
              effort: 'high',
              attuneExternalSelection: true,
            },
          });
        } else if (completedTurns === 4) {
          send({
            id: 51,
            method: 'thread/settings/update',
            params: {
              threadId: '00000000-0000-4000-8000-000000000001',
              model: 'copilot-agent::gpt-5.4',
              effort: 'high',
              serviceTier: 'default',
              attuneExternalSelection: true,
            },
          });
        } else {
          clearTimeout(timer);
          resolvePromise();
        }
      }
    });
    child.once('error', reject);
    send({ id: 41, method: 'initialize', params: {} });
  });
  child.kill('SIGTERM');

  const invocations = (await readFile(argsLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(invocations.length, 5);
  assert.deepEqual(invocations[0].slice(0, 6), [
    '--print', '--force', '--output-format', 'stream-json', '--model', 'auto',
  ]);
  const cursorSessionId = '33333333-3333-4333-8333-333333333333';
  assert.equal(invocations[1].includes('--resume'), false);
  assert.notEqual(
    invocations[1][invocations[1].indexOf('--session-id') + 1],
    cursorSessionId,
  );
  assert.equal(
    invocations[2][invocations[2].indexOf('--model') + 1],
    'gpt-5.4',
  );
  assert.equal(
    invocations[3][invocations[3].indexOf('--resume') + 1],
    cursorSessionId,
  );
  assert.equal(
    invocations[4][invocations[4].indexOf('--model') + 1],
    'gpt-5.4',
  );
  const grokPrompt = invocations[1][invocations[1].indexOf('-p') + 1];
  assert.match(grokPrompt, /User: Test cursor-agent\./);
  assert.match(grokPrompt, /Assistant \(Cursor\): CURSOR_DONE/);
  assert.match(grokPrompt, /Current user request:\nTest grok-4\.5\./);
  const firstCopilotPrompt = invocations[2][invocations[2].indexOf('--prompt') + 1];
  assert.match(firstCopilotPrompt, /Assistant \(Cursor\): CURSOR_DONE/);
  assert.match(firstCopilotPrompt, /Assistant \(Grok 4\.5\): GROK_DONE/);
  const resumedCursorPrompt = invocations[3].at(-1);
  assert.doesNotMatch(resumedCursorPrompt, /User: Test cursor-agent\./);
  assert.match(resumedCursorPrompt, /Assistant \(Grok 4\.5\): GROK_DONE/);
  assert.match(resumedCursorPrompt, /Assistant \(Copilot · GPT 5\.4\): COPILOT_DONE/);
  const externalSettingsModels = messages
    .filter(message => message.method === 'thread/settings/updated')
    .map(message => message.params.threadSettings.collaborationMode.settings.model);
  assert.deepEqual(
    externalSettingsModels,
    [
      'grok-4.5',
      'copilot-agent::gpt-5.4',
      'copilot-agent::gpt-5.4',
      'cursor-agent',
    ],
  );
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  const threadState = persisted.threads[threadId];
  assert.equal(threadState.model, 'copilot-agent::gpt-5.4');
  assert.deepEqual(Object.keys(threadState.sessions).sort(), [
    'copilot', 'cursor', 'grok',
  ]);

  function startTurn(id, model) {
    send({
      id,
      method: 'turn/start',
      params: {
        threadId,
        model,
        effort: 'high',
        input: [{
          type: 'text',
          text: `Test ${model}.`,
          text_elements: [],
        }],
      },
    });
  }

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
});

test('a valid settings request carries a nested model into new thread creation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'attune-new-thread-selection-test-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await chmod(mockCodex, 0o700);
  const statePath = join(stateRoot, 'state.json');
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: statePath,
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  const messages = [];
  const lines = createInterface({ input: child.stdout });

  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out applying a pending new-thread selection.')),
      10_000,
    );
    lines.on('line', line => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.id === 61) {
        send({
          id: 62,
          method: 'thread/settings/update',
          params: {
            threadId: '00000000-0000-4000-8000-000000000001',
            model: 'copilot-agent::gpt-5.4',
            effort: 'high',
            serviceTier: 'default',
            attuneExternalSelection: true,
          },
        });
      } else if (message.id === 62) {
        send({
          id: 64,
          method: 'attune/external-model/state',
          params: { threadId: null },
        });
      } else if (message.id === 64) {
        send({
          id: 63,
          method: 'thread/start',
          params: {
            // The pending selection must win even if ChatGPT creates the task
            // with a stale model from a different provider.
            model: 'claude-fable',
            effort: 'medium',
            serviceTier: 'default',
            cwd: runtimeRoot,
          },
        });
      } else if (message.id === 63) {
        send({
          id: 65,
          method: 'attune/external-model/state',
          params: { threadId: message.result.thread.id },
        });
      } else if (message.id === 65) {
        send({
          id: 66,
          method: 'thread/settings/update',
          params: {
            threadId: 'thread-attune-stream-test',
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
            serviceTier: 'fast',
          },
        });
      } else if (message.id === 66) {
        send({
          id: 67,
          method: 'attune/external-model/state',
          params: { threadId: 'thread-attune-stream-test' },
        });
      } else if (message.id === 67) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once('error', reject);
    send({ id: 61, method: 'initialize', params: {} });
  });
  child.kill('SIGTERM');

  assert.deepEqual(messages.find(message => message.id === 62).result, {});
  assert.deepEqual(messages.find(message => message.id === 64).result, {
    threadId: null,
    model: 'copilot-agent::gpt-5.4',
    externalModel: 'copilot-agent::gpt-5.4',
    parentModel: 'copilot-agent',
    providerId: 'copilot-agent',
    displayName: 'GPT 5.4',
    effort: 'high',
    serviceTier: 'default',
  });
  assert.equal(messages.find(message => message.id === 63).result.model, 'copilot-agent');
  assert.equal(messages.find(message => message.id === 63).result.reasoningEffort, 'high');
  assert.deepEqual(messages.find(message => message.id === 65).result, {
    threadId: 'thread-attune-stream-test',
    model: 'copilot-agent::gpt-5.4',
    externalModel: 'copilot-agent::gpt-5.4',
    parentModel: 'copilot-agent',
    providerId: 'copilot-agent',
    displayName: 'GPT 5.4',
    effort: 'high',
    serviceTier: 'default',
  });
  assert.deepEqual(messages.find(message => message.id === 67).result, {
    threadId: 'thread-attune-stream-test',
    model: 'gpt-5.6-sol',
    externalModel: null,
    parentModel: 'gpt-5.6-sol',
    providerId: null,
    displayName: 'GPT 5.6 Sol',
    effort: 'xhigh',
    serviceTier: 'fast',
  });
  const persisted = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(persisted.threads['thread-attune-stream-test'].model, null);
  assert.equal(
    persisted.threads['thread-attune-stream-test'].nativeModel,
    'gpt-5.6-sol',
  );
  assert.equal(persisted.threads['thread-attune-stream-test'].effort, 'xhigh');
  assert.equal(persisted.threads['thread-attune-stream-test'].serviceTier, 'fast');

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
});
