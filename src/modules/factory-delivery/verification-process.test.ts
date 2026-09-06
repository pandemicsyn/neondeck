import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as v from 'valibot';
import { runCandidateCheck } from './verification-process';
import { runSupervisedCandidateCheck } from './verification-supervisor';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(source: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'check-process-test-')),
  );
  roots.push(root);
  const script = join(root, 'check.mjs');
  await writeFile(script, source);
  return {
    root,
    script,
    input: {
      command: `${process.execPath} ${script}`,
      cwd: root,
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
    },
  };
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('bounded independent check process', () => {
  it('requires confirmed death for a normal command', async () => {
    const result = await runCandidateCheck({
      command: '/usr/bin/true',
      cwd: '/tmp',
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      noWriter: true,
      truncated: false,
      timedOut: false,
    });
  });
  it('terminates timeout and oversized output', async () => {
    expect(
      await runCandidateCheck({
        command: '/bin/sleep 3',
        cwd: '/tmp',
        timeoutMs: 30,
        maxOutputBytes: 1000,
      }),
    ).toMatchObject({ noWriter: true, timedOut: true });
    expect(
      await runCandidateCheck({
        command: '/usr/bin/yes',
        cwd: '/tmp',
        timeoutMs: 1000,
        maxOutputBytes: 100,
      }),
    ).toMatchObject({ noWriter: true, truncated: true });
  });
  it('rejects shell operators', async () => {
    await expect(
      runCandidateCheck({
        command: '/usr/bin/true; /usr/bin/true',
        cwd: '/tmp',
        timeoutMs: 1000,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow('configured command');
  });
  it('replaces operator home/config/data/cache/tmp and blocks Git credential helpers', async () => {
    const setup = await fixture(`
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const keys=['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','TMPDIR','NEONDECK_HOME'];
let gitFailed=false;
try {execFileSync('/usr/bin/git',['credential','fill'],{input:'protocol=https\\nhost=example.invalid\\n\\n',stdio:['pipe','pipe','pipe']});} catch {gitFailed=true;}
console.log(JSON.stringify({env:process.env,markers:keys.map(k=>existsSync(join(process.env[k],'operator-marker'))),gitFailed}));
`);
    const operator = join(setup.root, 'operator');
    await mkdir(operator);
    await writeFile(join(operator, 'operator-marker'), 'private');
    const helper = join(setup.root, 'credential-helper');
    await writeFile(
      helper,
      `#!/bin/sh\ntouch '${join(setup.root, 'helper-ran')}'\n`,
      { mode: 0o700 },
    );
    execFileSync(
      '/usr/bin/git',
      ['-c', 'init.defaultBranch=main', 'init', setup.root],
      { stdio: 'ignore' },
    );
    execFileSync('/usr/bin/git', [
      '-C',
      setup.root,
      'config',
      'credential.helper',
      helper,
    ]);
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
      'NEONDECK_HOME',
    ])
      vi.stubEnv(key, operator);
    for (const key of [
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'SSH_AUTH_SOCK',
      'NODE_OPTIONS',
      'BASH_ENV',
      'NPM_CONFIG_USERCONFIG',
    ])
      vi.stubEnv(key, 'operator-secret-or-pointer');
    vi.stubEnv('PATH', `${operator}:/usr/bin:/bin`);
    const jobDirectory = join(setup.root, 'job');
    const first = await runCandidateCheck(setup.input, { jobDirectory });
    expect(first).toMatchObject({
      exitCode: 0,
      noWriter: true,
      truncated: false,
    });
    const observed = v.parse(
      v.object({
        env: v.record(v.string(), v.string()),
        markers: v.array(v.boolean()),
        gitFailed: v.boolean(),
      }),
      JSON.parse(first.stdout),
    );
    expect(observed.markers).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(observed.gitFailed).toBe(true);
    expect(
      await readFile(join(setup.root, 'helper-ran')).catch(() => null),
    ).toBeNull();
    expect(
      Object.values(observed.env).some((value) => value.includes(operator)),
    ).toBe(false);
    for (const key of [
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'SSH_AUTH_SOCK',
      'NODE_OPTIONS',
      'BASH_ENV',
    ])
      expect(observed.env[key]).toBeUndefined();
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'TMPDIR',
      'NEONDECK_HOME',
    ]) {
      expect(observed.env[key].startsWith(`${jobDirectory}/`)).toBe(true);
      expect((await stat(observed.env[key])).mode & 0o777).toBe(0o700);
    }
    expect(first.environment).toMatchObject({
      policy: 'private-check-env-v1',
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    });
    expect(JSON.stringify(first.environment)).not.toContain(setup.root);
    expect(JSON.stringify(first.environment)).not.toContain('operator-secret');
    const second = await runCandidateCheck(setup.input, { jobDirectory });
    expect(second.environment).toEqual(first.environment);
    const attempt = join(setup.root, 'attempt');
    await mkdir(attempt, { mode: 0o700 });
    const supervised = await runSupervisedCandidateCheck(
      setup.input,
      { directory: attempt, attemptToken: 'a'.repeat(64) },
      'private-env',
    );
    expect(supervised).toMatchObject({
      exitCode: 0,
      noWriter: true,
      truncated: false,
    });
    const workerObserved = v.parse(
      v.object({
        env: v.record(v.string(), v.string()),
        markers: v.array(v.boolean()),
      }),
      JSON.parse(supervised.stdout),
    );
    expect(workerObserved.markers).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(
      Object.values(workerObserved.env).some((value) =>
        value.includes(operator),
      ),
    ).toBe(false);
    expect(supervised.environment).toEqual(first.environment);
    const changed = await runCandidateCheck(
      { ...setup.input, command: `${setup.input.command} changed` },
      { jobDirectory },
    );
    expect(changed.environment?.fingerprint).not.toBe(
      first.environment?.fingerprint,
    );
  });
  it('drains the complete stdout/stderr tail after successful leader exit', async () => {
    const setup = await fixture(`import {writeSync} from 'node:fs';
writeSync(1,Buffer.from('é'.repeat(180000)+'stdout-tail'));
writeSync(2,Buffer.from('z'.repeat(180000)+'stderr-tail'));
process.exit(0);`);
    const result = await runCandidateCheck(setup.input);
    expect(result).toMatchObject({
      exitCode: 0,
      truncated: false,
      noWriter: true,
    });
    expect(result.stdout).toBe('é'.repeat(180000) + 'stdout-tail');
    expect(result.stderr).toBe('z'.repeat(180000) + 'stderr-tail');
  });
  it('terminates inherited-pipe descendants then drains their already-written output', async () => {
    const setup = await fixture(`import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e',"process.stdout.write('descendant-tail',()=>process.send('ready'));setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});
child.on('message',()=>process.exit(0));`);
    const result = await runCandidateCheck(setup.input);
    expect(result).toMatchObject({
      exitCode: 0,
      truncated: false,
      noWriter: true,
      timedOut: false,
    });
    expect(result.stdout).toBe('descendant-tail');
    expect(result.durationMs).toBeLessThan(3000);
  });
  it('returns nonpassing incomplete output if an escaped pipe holder cannot be drained', async () => {
    // Deliberately demonstrates the documented absence of a same-UID sandbox.
    // The synthetic escaped descendant self-terminates; no generic process kill.
    const setup = await fixture(`import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),3500)"],{detached:true,stdio:['ignore','inherit','inherit']});
console.log(child.pid);process.exit(0);`);
    const result = await runCandidateCheck(setup.input, {
      jobDirectory: join(setup.root, 'job'),
    });
    expect(result).toMatchObject({
      exitCode: null,
      truncated: true,
      noWriter: false,
      timedOut: false,
    });
    const pid = v.parse(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
      Number(result.stdout.trim()),
    );
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      await delay(20);
    }
    expect(alive).toBe(false);
  });
  it('preserves cancellation and writer-death confirmation while draining', async () => {
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 50);
    try {
      const result = await runCandidateCheck(
        {
          command: '/bin/sleep 3',
          cwd: '/tmp',
          timeoutMs: 2000,
          maxOutputBytes: 1000,
        },
        { signal: cancellation.signal },
      );
      expect(result).toMatchObject({
        exitCode: null,
        noWriter: true,
        cancelled: true,
        timedOut: false,
      });
    } finally {
      clearTimeout(timer);
    }
  });
});
