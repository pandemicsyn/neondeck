#!/usr/bin/env node
// Synthetic OpenCode 1.18.29 run wire fixture. Never calls a provider.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

if (process.argv.includes('--version')) {
  console.log('mock-opencode 1.18.29');
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('opencode run [message..]\n--format json --model --agent --pure');
  process.exit(0);
}
const expected = ['run', '--format', 'json', '--model'];
if (
  !expected.every((value, index) => process.argv[index + 2] === value) ||
  process.argv.length !== 10 ||
  process.argv[7] !== '--agent' ||
  process.argv[8] !== 'build' ||
  process.argv[9] !== '--pure'
) {
  process.stderr.write('Unexpected fixture invocation\n');
  process.exit(2);
}
let prompt = '';
for await (const chunk of process.stdin) {
  prompt += chunk;
  if (Buffer.byteLength(prompt) > 1024 * 1024) process.exit(2);
}
if (!prompt.trim()) process.exit(2);
if (
  process.env.GITHUB_TOKEN ||
  process.env.OPENAI_API_KEY ||
  process.env.OPENCODE_AUTH_CONTENT
)
  process.exit(2);
const auth = JSON.parse(
  await readFile(
    join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
    'utf8',
  ),
);
if (
  Object.keys(auth).join() !== process.argv[6].split('/')[0] ||
  auth[process.argv[6].split('/')[0]].type !== 'api' ||
  !auth[process.argv[6].split('/')[0]].key
)
  process.exit(2);
const scenario = process.env.MOCK_OPENCODE_SCENARIO ?? 'success';
const sessionID = `ses_${randomUUID().replaceAll('-', '')}`;
let ordinal = 0;
const part = (type, messageID, extra = {}) => ({
  id: `prt_${++ordinal}`,
  sessionID,
  messageID,
  type,
  ...extra,
});
const emit = (type, data) =>
  process.stdout.write(
    JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + '\n',
  );
const start = (messageID) =>
  emit('step_start', { part: part('step-start', messageID) });
const finish = (messageID, reason) =>
  emit('step_finish', {
    part: part('step-finish', messageID, {
      reason,
      cost: 0,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  });
start('msg_fixture1');
if (scenario === 'malformed') {
  process.stdout.write('{malformed\n');
} else if (scenario === 'oversized') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\n');
} else if (scenario === 'stall' || scenario === 'child-dev-server') {
  if (scenario === 'child-dev-server') {
    spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    );
    finish('msg_fixture1', 'stop');
  }
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (scenario === 'failure') {
  emit('error', {
    error: {
      name: 'APIError',
      data: { message: 'Synthetic provider failure' },
    },
  });
  process.exitCode = 1;
} else if (prompt.includes('fixture:absent-terminal')) {
  // Exit with an unfinished model step.
} else if (prompt.includes('fixture:truncated')) {
  process.stdout.write('{"type":"step_finish"');
} else if (prompt.includes('fixture:stderr-flood')) {
  process.stderr.write('fixture diagnostic\n'.repeat(100_000));
} else {
  emit('tool_use', {
    part: part('tool', 'msg_fixture1', {
      callID: 'call_fixture',
      tool: 'edit',
      state: {
        status: 'completed',
        input: {},
        output: 'Synthetic edit',
        title: 'Edit',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }),
  });
  finish('msg_fixture1', 'tool-calls');
  await writeFile('mock-opencode-result.txt', 'Synthetic OpenCode candidate\n');
  start('msg_fixture2');
  emit('text', {
    part: part('text', 'msg_fixture2', {
      text: 'Synthetic candidate prepared.',
      time: { start: 3, end: 4 },
    }),
  });
  finish('msg_fixture2', 'stop');
  if (prompt.includes('fixture:duplicate-terminal'))
    finish('msg_fixture2', 'stop');
  if (prompt.includes('fixture:contradictory-terminal'))
    emit('error', { error: { name: 'APIError' } });
  if (prompt.includes('fixture:nonzero-exit')) process.exitCode = 1;
}
