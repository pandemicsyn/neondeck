import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./mockdex.mjs', import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'mockdex-test-'));
  roots.push(root);
  return root;
}
function run(
  cwd: string,
  scenario: string | undefined,
  args = ['exec', '--json', '-'],
  input = 'fixture prompt',
  closeInput = true,
) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: scenario === undefined ? {} : { MOCKDEX_SCENARIO: scenario },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: unknown) => {
    if (typeof chunk !== 'string') throw new Error('Expected text');
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: unknown) => {
    if (typeof chunk !== 'string') throw new Error('Expected text');
    stderr += chunk;
  });
  child.stdin.on('error', () => {}); // Rejected argv may close stdin immediately.
  if (closeInput) child.stdin.end(input);
  else child.stdin.write(input);
  const timeout = setTimeout(() => kill(), 5000);
  function kill() {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ESRCH'
      )
        throw error;
    }
  }
  const done = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: unknown, signal: unknown) => {
      if (
        (code !== null && typeof code !== 'number') ||
        (signal !== null && typeof signal !== 'string')
      ) {
        reject(new Error('Invalid process exit'));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  }).finally(() => clearTimeout(timeout));
  return { child, done, kill, output: () => stdout };
}
function events(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected event object');
      return Object.fromEntries(Object.entries(value));
    });
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Readiness deadline exceeded');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('mockdex test-only subprocess', () => {
  it('reports the exact fixture readiness version without a scenario or prompt', async () => {
    const cwd = await temp();
    const result = await run(cwd, undefined, ['--version'], '').done;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('mockdex codex-contract 0.150.1\n');
    expect(result.stderr).toBe('');
    expect(await readdir(cwd)).toEqual([]);
  });
  it('accepts exec flags and stdin, writes only the selected cwd and emits Codex events', async () => {
    const cwd = await temp();
    const selected = await temp();
    const result = await run(cwd, 'success', [
      'exec',
      '--json',
      '--cd',
      selected,
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '-m',
      'fixture',
      '-c',
      'model_reasoning_effort="low"',
      '--sandbox=workspace-write',
      '--color',
      'never',
      '-o',
      'last.txt',
      '-',
    ]).done;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(events(result.stdout).map((event) => event.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'item.completed',
      'turn.completed',
    ]);
    expect(events(result.stdout).at(-1)).toMatchObject({
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    });
    expect(await readFile(join(selected, 'mockdex-result.txt'), 'utf8')).toBe(
      'mockdex deterministic test change\n',
    );
    expect(await readFile(join(selected, 'last.txt'), 'utf8')).toBe(
      'mockdex test fixture completed.\n',
    );
    expect(await readdir(cwd)).toEqual([]);
  });
  it.each([
    ['exec', '--json'],
    ['exec', '--json', 'literal prompt'],
    ['exec', '--json', '--', '-literal'],
  ])('accepts prompt form %j', async (...args) => {
    expect((await run(await temp(), 'success', args).done).code).toBe(0);
  });
  it.each([undefined, '', 'unknown'])(
    'requires explicit scenario %s',
    async (scenario) => {
      const cwd = await temp();
      expect((await run(cwd, scenario).done).code).toBe(2);
      expect(await readdir(cwd)).toEqual([]);
    },
  );
  it.each([
    ['exec', '-'],
    ['resume', '--json', '-'],
    ['exec', '--json', '--unknown'],
    ['exec', '--json', '-C'],
    ['exec', '--json', '--sandbox', 'invalid'],
    ['exec', '--json', '--color=invalid'],
    ['exec', '--json', '-c', 'invalid'],
    ['exec', '--json', '-o', '../outside'],
    ['exec', '--json', '--add-dir', '/tmp'],
    ['exec', '--json', '--json=false'],
    ['exec', '--json', 'one', 'two'],
  ])('rejects unsupported or invalid invocation %j', async (...args) => {
    const cwd = await temp();
    expect((await run(cwd, 'success', args).done).code).toBe(2);
    expect(await readdir(cwd)).toEqual([]);
  });
  it.each(['', ' '.repeat(10), 'x'.repeat(65537)])(
    'rejects empty or excessive stdin (%#)',
    async (input) => {
      const cwd = await temp();
      expect((await run(cwd, 'success', undefined, input).done).code).toBe(2);
      expect(await readdir(cwd)).toEqual([]);
    },
  );
  it('bounds waiting for stdin EOF', async () => {
    const cwd = await temp();
    const task = run(cwd, 'success', undefined, 'pending', false);
    const result = await task.done;
    expect(result.code).toBe(2);
    expect(result.signal).toBeNull();
    expect(await readdir(cwd)).toEqual([]);
  });
  it('accepts a positional prompt with empty stdin', async () => {
    expect(
      (
        await run(await temp(), 'success', ['exec', '--json', 'prompt'], '')
          .done
      ).code,
    ).toBe(0);
  });
  it('rejects excessive positional prompt', async () => {
    const cwd = await temp();
    expect(
      (
        await run(cwd, 'success', ['exec', '--json', 'x'.repeat(65537)], '')
          .done
      ).code,
    ).toBe(2);
    expect(await readdir(cwd)).toEqual([]);
  });
  it('refuses a last-message symlink without modifying its outside target', async () => {
    const cwd = await temp();
    const outside = join(await temp(), 'target');
    await writeFile(outside, 'untouched');
    await symlink(outside, join(cwd, 'last.txt'));
    expect(
      (
        await run(cwd, 'success', ['exec', '--json', '-o', 'last.txt', '-'])
          .done
      ).code,
    ).toBe(2);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
  it('refuses symlink output and existing files without overwriting their targets', async () => {
    const cwd = await temp();
    const outside = join(await temp(), 'target');
    await writeFile(outside, 'untouched');
    await symlink(outside, join(cwd, 'mockdex-result.txt'));
    expect((await run(cwd, 'success').done).code).toBe(2);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    await rm(join(cwd, 'mockdex-result.txt'));
    await writeFile(join(cwd, 'mockdex-result.txt'), 'existing');
    expect((await run(cwd, 'success').done).code).toBe(2);
    expect(await readFile(join(cwd, 'mockdex-result.txt'), 'utf8')).toBe(
      'existing',
    );
  });
  it('fails with a nonzero exit and no success event or writes', async () => {
    const cwd = await temp();
    const result = await run(cwd, 'failure').done;
    expect(result.code).toBe(1);
    expect(events(result.stdout).at(-1)).toEqual({
      type: 'turn.failed',
      error: { message: 'mockdex intentional failure' },
    });
    expect(await readdir(cwd)).toEqual([]);
  });
  it('emits deliberately malformed output', async () => {
    const result = await run(await temp(), 'malformed').done;
    expect(result.code).toBe(0);
    expect(() => events(result.stdout)).toThrow(SyntaxError);
    expect(result.stdout).not.toContain('turn.completed');
  });
  it('emits a bounded oversized JSONL line', async () => {
    const result = await run(await temp(), 'oversized').done;
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(result.stdout.length).toBeLessThan(2 * 1024 * 1024 + 1024);
    expect(events(result.stdout).at(-1)).toMatchObject({
      type: 'item.completed',
    });
  });
  it('stalls until cancellation without claiming completion', async () => {
    const task = run(await temp(), 'stall');
    try {
      await until(() => task.output().includes('turn.started'));
      expect(task.child.exitCode).toBeNull();
    } finally {
      task.kill();
    }
    expect((await task.done).signal).toBe('SIGKILL');
    expect(task.output()).not.toContain('turn.completed');
  });
  it.skipIf(process.platform === 'win32')(
    'kills both parent and listening child through the process group',
    async () => {
      const task = run(await temp(), 'child-dev-server');
      let port = 0;
      try {
        await until(() => task.output().includes('command_execution'));
        const item = events(task.output()).at(-1)?.item;
        if (
          !item ||
          typeof item !== 'object' ||
          !('aggregated_output' in item) ||
          typeof item.aggregated_output !== 'string'
        )
          throw new Error('Missing readiness');
        const ready: unknown = JSON.parse(item.aggregated_output);
        if (
          !ready ||
          typeof ready !== 'object' ||
          !('port' in ready) ||
          typeof ready.port !== 'number' ||
          !Number.isInteger(ready.port) ||
          ready.port < 1 ||
          ready.port > 65535 ||
          !('pid' in ready) ||
          typeof ready.pid !== 'number'
        )
          throw new Error('Invalid readiness');
        port = ready.port;
        expect(ready.pid).not.toBe(task.child.pid);
        expect(
          await (
            await fetch(`http://127.0.0.1:${port}`, {
              signal: AbortSignal.timeout(1000),
            })
          ).text(),
        ).toBe('mockdex test server\n');
      } finally {
        task.kill();
      }
      expect((await task.done).signal).toBe('SIGKILL');
      await until(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(200),
          });
          return false;
        } catch {
          return true;
        }
      });
    },
  );
});
