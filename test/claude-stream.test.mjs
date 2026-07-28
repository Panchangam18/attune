import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClaudeStreamDecoder,
  completeCodexToolItem,
  createCodexToolItem,
} from '../dist/claude-stream.js';

test('Claude stream decoder emits incremental text without duplicating the assistant snapshot', () => {
  const decoder = new ClaudeStreamDecoder();
  const updates = [
    ...decoder.push({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg_test' },
      },
      session_id: 'session-test',
    }),
    ...decoder.push({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    }),
    ...decoder.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'STREAM_' },
      },
    }),
    ...decoder.push({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
    }),
    ...decoder.push({
      type: 'assistant',
      message: {
        id: 'msg_test',
        content: [{ type: 'text', text: 'STREAM_OK' }],
      },
    }),
    ...decoder.push({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      },
    }),
    ...decoder.push({
      type: 'stream_event',
      event: { type: 'message_stop' },
    }),
  ];

  assert.deepEqual(
    updates.filter(update => update.type === 'textDelta').map(update => update.text),
    ['STREAM_', 'OK'],
  );
  assert.deepEqual(
    updates.find(update => update.type === 'messageFinished'),
    { type: 'messageFinished', messageId: 'msg_test', stopReason: 'end_turn' },
  );
  assert.ok(updates.some(update => update.type === 'session' && update.sessionId === 'session-test'));
});

test('Claude stream decoder pairs structured tool calls with their results', () => {
  const decoder = new ClaudeStreamDecoder();
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'msg_tool' },
    },
  });
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'Bash',
        input: {},
      },
    },
  });
  const started = decoder.push({
    type: 'assistant',
    message: {
      id: 'msg_tool',
      content: [{
        type: 'tool_use',
        id: 'toolu_test',
        name: 'Bash',
        input: { command: 'printf ok' },
      }],
    },
  });
  const duplicate = decoder.push({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
  });
  const completed = decoder.push({
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_test',
        content: 'ok',
        is_error: false,
      }],
    },
  });

  assert.deepEqual(started, [{
    type: 'toolStarted',
    call: {
      id: 'toolu_test',
      name: 'Bash',
      input: { command: 'printf ok' },
    },
  }]);
  assert.equal(duplicate.filter(update => update.type === 'toolStarted').length, 0);
  assert.deepEqual(completed, [{
    type: 'toolFinished',
    toolUseId: 'toolu_test',
    output: 'ok',
    isError: false,
  }]);
});

test('Claude stream decoder reconstructs tool input from partial JSON alone', () => {
  const decoder = new ClaudeStreamDecoder();
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id: 'msg_partial_tool' },
    },
  });
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_partial',
        name: 'Read',
        input: {},
      },
    },
  });
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"file_path":',
      },
    },
  });
  decoder.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '"/tmp/file.txt"}',
      },
    },
  });
  const updates = decoder.push({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
  });

  assert.deepEqual(updates, [{
    type: 'toolStarted',
    call: {
      id: 'toolu_partial',
      name: 'Read',
      input: { file_path: '/tmp/file.txt' },
    },
  }]);
});

test('Claude stream decoder reports subagent text as parent tool progress', () => {
  const decoder = new ClaudeStreamDecoder();
  decoder.push({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_parent',
    event: {
      type: 'message_start',
      message: { id: 'msg_child' },
    },
  });
  decoder.push({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_parent',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Child agent progress' },
    },
  });
  const updates = decoder.push({
    type: 'stream_event',
    parent_tool_use_id: 'toolu_parent',
    event: { type: 'message_stop' },
  });

  assert.deepEqual(updates, [{
    type: 'toolProgress',
    toolUseId: 'toolu_parent',
    message: 'Child agent progress',
  }]);
});

test('Claude tools map to native Codex command, web, and generic tool items', () => {
  const bash = createCodexToolItem({
    id: 'bash-1',
    name: 'Bash',
    input: { command: 'npm test' },
  }, '/tmp/project');
  assert.equal(bash.type, 'commandExecution');
  assert.equal(bash.command, 'npm test');
  assert.equal(bash.status, 'inProgress');

  const read = createCodexToolItem({
    id: 'read-1',
    name: 'Read',
    input: { file_path: 'package.json' },
  }, '/tmp/project');
  assert.equal(read.type, 'commandExecution');
  assert.deepEqual(read.commandActions, [{
    type: 'read',
    command: 'Read /tmp/project/package.json',
    name: 'package.json',
    path: '/tmp/project/package.json',
  }]);

  const web = createCodexToolItem({
    id: 'web-1',
    name: 'WebSearch',
    input: { query: 'Attune' },
  }, '/tmp/project');
  assert.equal(web.type, 'webSearch');
  assert.equal(web.query, 'Attune');

  const edit = createCodexToolItem({
    id: 'edit-1',
    name: 'Edit',
    input: { file_path: '/tmp/project/index.ts' },
  }, '/tmp/project');
  assert.equal(edit.type, 'mcpToolCall');
  assert.equal(edit.server, 'Claude Code');
  assert.equal(edit.tool, 'Edit');

  const completed = completeCodexToolItem(bash, 'all tests passed', false, 42);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.aggregatedOutput, 'all tests passed');
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.durationMs, 42);
});

test('Claude error results remain structured and immediately actionable', () => {
  const decoder = new ClaudeStreamDecoder();
  const updates = decoder.push({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Tool execution failed',
    session_id: 'session-error',
    duration_ms: 120,
  });
  const result = updates.find(update => update.type === 'result');
  assert.deepEqual(result, {
    type: 'result',
    result: 'Tool execution failed',
    sessionId: 'session-error',
    isError: true,
    errorMessage: 'Tool execution failed',
    durationMs: 120,
  });
});
