#!/usr/bin/env node

const sessionId = '11111111-1111-4111-8111-111111111111';
const waitForInterrupt = process.argv.at(-1)?.includes('WAIT_FOR_INTERRUPT') === true;
const disallowedToolsIndex = process.argv.indexOf('--disallowedTools');
const systemPromptIndex = process.argv.indexOf('--append-system-prompt');
if (
  disallowedToolsIndex < 0
  || process.argv[disallowedToolsIndex + 1] !== 'AskUserQuestion'
  || systemPromptIndex < 0
  || !process.argv[systemPromptIndex + 1]?.includes('claude-fable-5')
) {
  process.stderr.write('Missing Attune Claude bridge instructions.\n');
  process.exit(2);
}
const events = [
  {
    type: 'system',
    subtype: 'init',
    status: 'ready',
    session_id: sessionId,
  },
  {
    type: 'system',
    subtype: 'status',
    status: 'requesting',
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'msg_mock_tool' },
    },
    session_id: sessionId,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_mock_tool',
      content: [{
        type: 'tool_use',
        id: 'toolu_mock_bash',
        name: 'Bash',
        input: {
          command: 'printf MOCK_TOOL_OK',
          description: 'Run mock command',
        },
      }],
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: { type: 'message_stop' },
    session_id: sessionId,
  },
  {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_mock_bash',
        content: 'MOCK_TOOL_OK',
        is_error: false,
      }],
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'msg_mock_final' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'LIVE_' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'DONE' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
    },
    session_id: sessionId,
  },
  {
    type: 'stream_event',
    event: { type: 'message_stop' },
    session_id: sessionId,
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'LIVE_DONE',
    duration_ms: 75,
    session_id: sessionId,
  },
];

let index = 0;
if (waitForInterrupt) {
  process.stdout.write(`${JSON.stringify(events[0])}\n`);
  setInterval(() => {}, 1000);
} else {
  const timer = setInterval(() => {
    if (index >= events.length) {
      clearInterval(timer);
      return;
    }
    process.stdout.write(`${JSON.stringify(events[index])}\n`);
    index += 1;
  }, 5);
}
