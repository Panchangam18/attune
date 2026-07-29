#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sessionId = '33333333-3333-4333-8333-333333333333';
if (process.env.ATTUNE_EXTERNAL_AGENT_ARGS_LOG) {
  appendFileSync(
    process.env.ATTUNE_EXTERNAL_AGENT_ARGS_LOG,
    `${JSON.stringify(args)}\n`,
  );
}

if (args.includes('--list-models')) {
  process.stdout.write([
    'Available models',
    '',
    'auto - Auto (current, default)',
    'gpt-5.4 - GPT-5.4',
    'claude-sonnet-5 - Sonnet 5',
    '',
  ].join('\n'));
} else if (args[0] === 'about') {
  process.stdout.write([
    'About Cursor CLI',
    '',
    'CLI Version         test',
    'Model               Auto',
    'Subscription Tier   Free',
    '',
  ].join('\n'));
} else if (args.includes('streaming-json')) {
  if (
    !args.includes('--no-auto-update')
    || !args.includes('--yolo')
    || args[args.indexOf('--model') + 1] !== 'grok-4.5'
    || args[args.indexOf('--effort') + 1] !== 'high'
    || !args[args.indexOf('--rules') + 1]?.includes('Grok 4.5')
  ) {
    process.stderr.write('Invalid Grok bridge arguments.\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ type: 'thought', data: 'reasoning' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'text', data: 'GROK_' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'text', data: 'DONE' })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'end',
    stopReason: 'EndTurn',
    sessionId,
  })}\n`);
} else if (args.includes('json')) {
  const selectedModel = args[args.indexOf('--model') + 1];
  if (
    !args.includes('--allow-all')
    || !args.includes('--no-ask-user')
    || !['auto', 'gpt-5.4'].includes(selectedModel)
    || (selectedModel === 'auto'
      ? args.includes('--effort')
      : args[args.indexOf('--effort') + 1] !== 'high')
    || !args[args.indexOf('--prompt') + 1]?.includes('Copilot')
  ) {
    process.stderr.write('Invalid Copilot bridge arguments.\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({
    type: 'assistant.message_start',
    data: { messageId: 'msg_copilot' },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'assistant.message_delta',
    data: { messageId: 'msg_copilot', deltaContent: 'COPILOT_' },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'assistant.message_delta',
    data: { messageId: 'msg_copilot', deltaContent: 'DONE' },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    sessionId,
    exitCode: 0,
  })}\n`);
} else {
  const modelIndex = args.indexOf('--model');
  if (
    !args.includes('--print')
    || !args.includes('--force')
    || args[args.indexOf('--output-format') + 1] !== 'stream-json'
    || !['auto', 'gpt-5.4'].includes(args[modelIndex + 1])
    || !args.at(-1)?.includes('Cursor')
  ) {
    process.stderr.write('Invalid Cursor bridge arguments.\n');
    process.exit(2);
  }
  const event = (value) => process.stdout.write(`${JSON.stringify({
    ...value,
    session_id: sessionId,
  })}\n`);
  event({ type: 'system', subtype: 'init' });
  event({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'CURSOR_' }] },
  });
  event({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] },
  });
  event({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'CURSOR_DONE',
  });
}
