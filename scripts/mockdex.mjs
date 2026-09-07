#!/usr/bin/env node
// TEST ONLY. Never use as an automatic fallback for a missing Codex executable.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const scenarios = new Set([
  'success',
  'failure',
  'malformed',
  'oversized',
  'stall',
  'child-dev-server',
]);
const switches = new Set([
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--strict-config',
  '--full-auto',
  '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox',
]);
const values = new Set([
  '-C',
  '--cd',
  '-m',
  '--model',
  '-s',
  '--sandbox',
  '-c',
  '--config',
  '-p',
  '--profile',
  '--color',
  '--enable',
  '--disable',
  '--thread-source',
  '-o',
  '--output-last-message',
]);
const maxInput = 64 * 1024;
const message = 'mockdex test fixture completed.';

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message, code = 2) {
  emit({ type: 'turn.failed', error: { message } });
  process.exitCode = code;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--version') {
    console.log('mockdex codex-contract 0.150.1');
    return;
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      'TEST ONLY: MOCKDEX_SCENARIO=<scenario> mockdex exec --json [-C cwd] [prompt|-]',
    );
    return;
  }
  if (args.shift() !== 'exec') throw new Error('Expected exec subcommand');
  const scenario = process.env.MOCKDEX_SCENARIO;
  if (!scenarios.has(scenario))
    throw new Error('Explicit valid MOCKDEX_SCENARIO required');
  let cwd = process.cwd();
  let prompt;
  let output;
  let json = false;
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!positional && argument === '--') {
      positional = true;
      continue;
    }
    if (!positional && argument.startsWith('-') && argument !== '-') {
      const separator = argument.indexOf('=');
      const flag = separator < 0 ? argument : argument.slice(0, separator);
      if (switches.has(flag)) {
        if (separator >= 0)
          throw new Error('Boolean flags do not accept values');
        if (flag === '--json') json = true;
        continue;
      }
      if (!values.has(flag)) throw new Error('Unsupported mockdex option');
      const value =
        separator < 0 ? args[++index] : argument.slice(separator + 1);
      if (!value || value.startsWith('-'))
        throw new Error('Missing option value');
      if (['-C', '--cd'].includes(flag)) cwd = value;
      if (['-o', '--output-last-message'].includes(flag)) output = value;
      if (
        ['-s', '--sandbox'].includes(flag) &&
        !['read-only', 'workspace-write', 'danger-full-access'].includes(value)
      )
        throw new Error('Invalid sandbox');
      if (flag === '--color' && !['auto', 'always', 'never'].includes(value))
        throw new Error('Invalid color');
      if (['-c', '--config'].includes(flag) && !/^[\w.-]+=.+$/s.test(value))
        throw new Error('Invalid config override');
      continue;
    }
    if (prompt !== undefined) throw new Error('Expected a single prompt');
    prompt = argument;
  }
  if (!json) throw new Error('--json required');
  cwd = await realpath(cwd);
  if (!(await stat(cwd)).isDirectory())
    throw new Error('cwd must be a directory');
  // A single new leaf file avoids parent-directory symlink traversal and overwrite.
  if (
    output !== undefined &&
    (output !== basename(output) ||
      !/^[\w.-]+$/.test(output) ||
      ['.', '..', 'mockdex-result.txt'].includes(output))
  )
    throw new Error('Output must be a new leaf filename inside cwd');
  if (prompt !== undefined && Buffer.byteLength(prompt) > maxInput)
    throw new Error('Prompt exceeds 64 KiB');
  let bytes = 0;
  let hasText = false;
  const timer = setTimeout(
    () => process.stdin.destroy(new Error('stdin deadline exceeded')),
    2000,
  );
  try {
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid stdin chunk');
        bytes += chunk.length;
        if (bytes > maxInput) throw new Error('stdin exceeds 64 KiB');
        if (chunk.toString('utf8').trim()) hasText = true;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!(prompt && prompt !== '-' && prompt.trim()) && !hasText)
    throw new Error('Nonempty prompt required');
  emit({
    type: 'thread.started',
    thread_id: randomUUID(),
  });
  emit({ type: 'turn.started' });
  if (scenario === 'failure') {
    fail('mockdex intentional failure', 1);
    return;
  }
  if (scenario === 'malformed') {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (scenario === 'oversized') {
    emit({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'agent_message',
        text: 'x'.repeat(2 * 1024 * 1024),
      },
    });
    return;
  }
  if (scenario === 'stall' || scenario === 'child-dev-server') {
    // Bounded escape hatch if a test neglects cancellation. No terminal success.
    const lifetime = setTimeout(() => {
      fail('mockdex fixture lifetime exceeded', 124);
    }, 30_000);
    if (scenario === 'child-dev-server') {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { createServer } from 'node:http';
        const server = createServer((request, response) => response.end('mockdex test server\\n'));
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (!address || typeof address === 'string') process.exit(2);
          process.send({ pid: process.pid, port: address.port });
          process.disconnect();
        });
        setTimeout(() => server.closeAllConnections() || server.close(), 30000);
      `,
        ],
        { cwd, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      let ready;
      try {
        [ready] = await once(child, 'message', {
          signal: AbortSignal.timeout(2000),
        });
      } catch (error) {
        clearTimeout(lifetime);
        child.kill('SIGKILL');
        throw error;
      }
      if (
        !ready ||
        typeof ready !== 'object' ||
        !Number.isInteger(ready.pid) ||
        ready.pid !== child.pid ||
        !Number.isInteger(ready.port) ||
        ready.port < 1 ||
        ready.port > 65535
      ) {
        clearTimeout(lifetime);
        child.kill('SIGKILL');
        throw new Error('Invalid child readiness');
      }
      emit({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'mockdex child dev server',
          status: 'in_progress',
          aggregated_output: JSON.stringify(ready),
        },
      });
      // Intentionally no parent signal forwarding: the executor must kill the group.
    }
    return;
  }
  await createFile(
    cwd,
    'mockdex-result.txt',
    'mockdex deterministic test change\n',
  );
  if (output) await createFile(cwd, output, `${message}\n`);
  emit({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'file_change',
      changes: [{ path: 'mockdex-result.txt', kind: 'add' }],
      status: 'completed',
    },
  });
  emit({
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: message },
  });
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  });
}

async function createFile(cwd, name, content) {
  const file = await open(join(cwd, name), 'wx', 0o600);
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}

main().catch(() => fail('mockdex rejected input or fixture setup failed'));
