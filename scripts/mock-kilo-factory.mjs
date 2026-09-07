#!/usr/bin/env node
// Synthetic Kilo 7.4.23 run JSONL. No provider SDK, credentials or model calls.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as v from 'valibot';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  console.log('mock-kilo-factory 7.4.23');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(
    'Synthetic kilo run --format json --model kilo/<model> --agent build --auto --pure',
  );
  process.exit(0);
}
if (
  args[0] !== 'run' ||
  args[1] !== '--format' ||
  args[2] !== 'json' ||
  args[3] !== '--model' ||
  !args[4]?.startsWith('kilo/') ||
  args[5] !== '--agent' ||
  args[6] !== 'build' ||
  args[7] !== '--auto' ||
  args[8] !== '--pure' ||
  args.length !== 9
) {
  console.error('Unexpected synthetic Kilo invocation');
  process.exit(2);
}
let scenario = v.parse(
  v.picklist([
    'success',
    'failure',
    'malformed',
    'oversized',
    'stall',
    'child-dev-server',
    'absent-terminal',
    'duplicate-terminal',
    'contradictory-terminal',
    'foreign-session',
    'truncated',
    'stderr-flood',
    'nonzero',
  ]),
  process.env.MOCK_KILO_FACTORY_SCENARIO ?? 'success',
);
let promptBytes = 0;
let prompt = '';
for await (const chunk of process.stdin) {
  promptBytes += Buffer.byteLength(chunk);
  if (promptBytes > 1024 * 1024) process.exit(2);
  prompt += chunk.toString('utf8');
}
if (promptBytes === 0) process.exit(2);
if (prompt.includes('fixture:absent-terminal')) scenario = 'absent-terminal';
const sessionID = `ses_${randomUUID().replaceAll('-', '')}`;
let ordinal = 0;
const part = (type, extra = {}) => ({
  id: `prt_${++ordinal}`,
  messageID: 'msg_factory_kilo',
  sessionID,
  type,
  ...extra,
});
const emit = (type, extra = {}) =>
  console.log(
    JSON.stringify({ type, timestamp: Date.now(), sessionID, ...extra }),
  );
emit('step_start', { part: part('step-start') });
if (scenario === 'malformed') {
  console.log('{bad json');
  process.exit(0);
}
if (scenario === 'oversized') {
  await new Promise((resolve) =>
    process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\n', resolve),
  );
  process.exit(0);
}
if (scenario === 'stderr-flood') {
  await new Promise((resolve) =>
    process.stderr.write('x'.repeat(2 * 1024 * 1024), resolve),
  );
  process.exit(0);
}
if (scenario === 'stall') setInterval(() => {}, 1000);
else if (scenario === 'failure') {
  emit('error', {
    error: { name: 'SyntheticKiloError', data: { message: 'fixture failure' } },
  });
  process.exitCode = 1;
} else {
  if (scenario === 'child-dev-server') {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      {
        stdio: 'ignore',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
    child.unref();
  }
  await writeFile(
    'mock-kilo-result.txt',
    'Synthetic Kilo factory candidate\n',
    { mode: 0o600 },
  );
  emit('text', { part: part('text', { text: 'Synthetic change prepared.' }) });
  const terminal = {
    part: part('step-finish', {
      reason: 'stop',
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
  };
  if (scenario === 'truncated')
    process.stdout.write(
      JSON.stringify({
        type: 'step_finish',
        timestamp: Date.now(),
        sessionID,
        ...terminal,
      }),
    );
  else if (scenario !== 'absent-terminal') emit('step_finish', terminal);
  if (scenario === 'duplicate-terminal') emit('step_finish', terminal);
  if (scenario === 'contradictory-terminal')
    emit('error', { error: 'contradictory fixture failure' });
  if (scenario === 'foreign-session')
    emit('text', {
      sessionID: 'ses_foreign',
      part: part('text', { text: 'foreign' }),
    });
  if (scenario === 'nonzero') process.exitCode = 1;
  if (scenario === 'child-dev-server') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
}
