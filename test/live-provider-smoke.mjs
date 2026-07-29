#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const testRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = dirname(testRoot);
const proxy = join(runtimeRoot, 'dist', 'claude-codex-proxy.js');
const mockCodex = join(testRoot, 'fixtures', 'mock-codex-app-server.mjs');
const allProviders = [
  { model: 'claude-fable', label: 'Claude Fable 5' },
  { model: 'claude-opus', label: 'Claude Opus 5' },
  { model: 'grok-4.5', label: 'Grok 4.5' },
  { model: 'cursor-agent', label: 'Cursor' },
  { model: 'copilot-agent', label: 'Copilot' },
];
const requestedSelectors = process.argv.slice(2);
const providers = requestedSelectors.length
  ? requestedSelectors.map(selector => {
    const separator = selector.lastIndexOf('@');
    const hasEffort = separator > 0;
    const model = hasEffort ? selector.slice(0, separator) : selector;
    const effort = hasEffort ? selector.slice(separator + 1) : null;
    const knownProvider = allProviders.find(provider => provider.model === model);
    return {
      model,
      label: knownProvider?.label ?? model,
      effort,
    };
  })
  : allProviders;

if (!providers.length) {
  throw new Error(`No matching providers: ${requestedSelectors.join(', ')}`);
}

const stateRoot = await mkdtemp(join(tmpdir(), 'attune-live-provider-smoke-'));
const results = [];

try {
  for (const provider of providers) {
    process.stdout.write(
      `Testing ${provider.label}${provider.effort ? ` @ ${provider.effort}` : ''} `
      + 'through Attune…\n',
    );
    const result = await smokeProvider(provider, stateRoot);
    results.push(result);
    process.stdout.write(
      `PASS ${provider.label}${provider.effort ? ` @ ${provider.effort}` : ''}: `
      + `${result.deltaCount} native text delta(s), `
      + `${result.itemCount} native item event(s), ${result.durationMs}ms\n`,
    );
  }
} finally {
  await rm(stateRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);

async function smokeProvider(provider, root) {
  const startedAt = Date.now();
  const statePath = join(root, `${provider.model}.json`);
  const child = spawn(process.execPath, [proxy, 'app-server'], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ATTUNE_CLAUDE_CODEX_STATE_PATH: statePath,
      ATTUNE_REAL_CODEX_CLI_PATH: mockCodex,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });

  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${provider.label} timed out.\n${stderr}`));
      }, 180_000);

      lines.on('line', line => {
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          reject(new Error(`Invalid proxy output for ${provider.label}: ${line}`, {
            cause: error,
          }));
          return;
        }
        messages.push(message);
        if (message.id === 1) {
          send({
            id: 2,
            method: 'thread/start',
            params: {
              model: provider.model,
              cwd: runtimeRoot,
              ephemeral: true,
            },
          });
        } else if (message.id === 2) {
          const expectedResponse = smokeSentinel(provider);
          const effort = provider.effort
            ?? (provider.model === 'claude-opus' || provider.model === 'grok-4.5'
              ? 'high'
              : 'medium');
          send({
            id: 3,
            method: 'turn/start',
            params: {
              threadId: message.result.thread.id,
              model: provider.model,
              effort,
              input: [{
                type: 'text',
                text: `Reply with only ${expectedResponse}. Do not use tools.`,
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
        if (code && code !== 143) {
          clearTimeout(timer);
          reject(new Error(
            `${provider.label} proxy exited with ${code}.\n${stderr}`,
          ));
        }
      });
      send({ id: 1, method: 'initialize', params: {} });
    });
  } finally {
    child.kill('SIGTERM');
    lines.close();
  }

  const completed = messages.find(message => message.method === 'turn/completed');
  const deltas = messages.filter(message => message.method === 'item/agentMessage/delta');
  const itemEvents = messages.filter(message => (
    message.method === 'item/started' || message.method === 'item/completed'
  ));
  const response = deltas.map(message => message.params.delta).join('').trim();
  const expectedResponse = smokeSentinel(provider);
  const expectedEffort = provider.effort
    ?? (provider.model === 'claude-opus' || provider.model === 'grok-4.5'
      ? 'high'
      : 'medium');
  const storedState = JSON.parse(await readFile(statePath, 'utf8'));
  const storedThread = Object.values(storedState.threads ?? {})[0];

  if (completed?.params?.turn?.status !== 'completed') {
    throw new Error(
      `${provider.label} did not complete natively: `
      + `${JSON.stringify(completed?.params?.turn)}\n${stderr}`,
    );
  }
  if (!response) {
    throw new Error(`${provider.label} emitted no native assistant deltas.\n${stderr}`);
  }
  if (response !== expectedResponse) {
    throw new Error(
      `${provider.label} returned an unexpected response: ${JSON.stringify(response)}`,
    );
  }
  if (storedThread?.model !== provider.model) {
    throw new Error(
      `${provider.label} persisted the wrong model: ${storedThread?.model}`,
    );
  }
  if (storedThread?.effort !== expectedEffort) {
    throw new Error(
      `${provider.label} persisted the wrong effort: ${storedThread?.effort}`,
    );
  }

  return {
    provider: provider.label,
    model: provider.model,
    effort: expectedEffort,
    response,
    deltaCount: deltas.length,
    itemCount: itemEvents.length,
    durationMs: Date.now() - startedAt,
  };

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function smokeSentinel(provider) {
  return `ATTUNE_SMOKE_${provider.model}_${provider.effort ?? 'default'}`
    .replaceAll(/[^a-zA-Z0-9_]/g, '_');
}
