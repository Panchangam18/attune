import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('ChatGPT message timestamps are preserved in the Codex rollout', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'attune-chatgpt-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const moduleUrl = pathToFileURL(resolve('dist/codex-chatgpt.js')).href;
  const script = `
    import { createCodexTaskFromChatGpt } from ${JSON.stringify(moduleUrl)};
    const task = createCodexTaskFromChatGpt({
      title: 'Timestamp test',
      messages: [
        { role: 'user', text: 'First question', timestamp: '2024-02-03T04:05:06.000Z' },
        { role: 'assistant', text: 'First answer', timestamp: '2024-02-03T04:05:08.500Z' },
        { role: 'user', text: 'Second question', timestamp: '2024-02-03T05:06:07.000Z' },
        { role: 'assistant', text: 'Second answer', timestamp: '2024-02-03T05:06:09.250Z' }
      ]
    });
    process.stdout.write(JSON.stringify(task));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);

  const task = JSON.parse(child.stdout);
  const events = (await readFile(task.rolloutPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const sessionMeta = events.find(event => event.type === 'session_meta');
  const messages = events.filter(event => event.type === 'response_item' && event.payload.type === 'message');

  assert.equal(sessionMeta.timestamp, '2024-02-03T04:05:06.000Z');
  assert.deepEqual(
    messages.map(message => [message.payload.role, message.timestamp]),
    [
      ['user', '2024-02-03T04:05:06.000Z'],
      ['assistant', '2024-02-03T04:05:08.500Z'],
      ['user', '2024-02-03T05:06:07.000Z'],
      ['assistant', '2024-02-03T05:06:09.250Z'],
    ],
  );
});

test('ChatGPT imports use a neutral cwd instead of an existing Codex project', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'attune-chatgpt-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const moduleUrl = pathToFileURL(resolve('dist/codex-chatgpt.js')).href;
  const script = `
    import { createCodexTaskFromChatGpt } from ${JSON.stringify(moduleUrl)};
    const task = createCodexTaskFromChatGpt({
      title: 'Project isolation test',
      cwd: '/Users/madhavan/attune-app',
      messages: [{ role: 'user', text: 'Keep this chat unprojected.' }]
    });
    process.stdout.write(JSON.stringify(task));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);

  const task = JSON.parse(child.stdout);
  assert.equal(task.cwd, join(home, '.attune', 'chatgpt-imports'));
});

test('ChatGPT Markdown formatting is preserved in Codex assistant messages', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'attune-chatgpt-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const markdown = '# Result\\n\\n- **Bold item**\\n- [Linked item](https://example.com)\\n\\n```js\\nconsole.log(\"formatted\");\\n```';
  const moduleUrl = pathToFileURL(resolve('dist/codex-chatgpt.js')).href;
  const script = `
    import { readFileSync } from 'node:fs';
    import { createCodexTaskFromChatGpt } from ${JSON.stringify(moduleUrl)};
    const markdown = ${JSON.stringify(markdown)};
    const task = createCodexTaskFromChatGpt({
      messages: [
        { role: 'user', text: 'Show formatted output.' },
        { role: 'assistant', text: markdown }
      ]
    });
    const events = readFileSync(task.rolloutPath, 'utf8').trim().split('\\n').map(JSON.parse);
    const assistant = events.find(event =>
      event.type === 'response_item'
      && event.payload.type === 'message'
      && event.payload.role === 'assistant'
    );
    process.stdout.write(JSON.stringify(assistant.payload.content[0].text));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout), markdown);
});
