import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { KiloEvents } from './kilo-events.ts';

const script = fileURLToPath(
  new URL('../../../../scripts/mock-kilo-factory.mjs', import.meta.url),
);
const args = [
  script,
  'run',
  '--format',
  'json',
  '--model',
  'kilo/fixture/model',
  '--agent',
  'build',
  '--auto',
  '--pure',
];

async function fixture(scenario: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'kilo-process-'));
  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      failed: boolean;
    }>((resolve) => {
      const child = execFile(
        process.execPath,
        args,
        {
          cwd,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: cwd,
            MOCK_KILO_FACTORY_SCENARIO: scenario,
          },
          timeout: 3000,
          maxBuffer: 3 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) =>
          resolve(
            v.parse(
              v.strictObject({
                stdout: v.string(),
                stderr: v.string(),
                failed: v.boolean(),
              }),
              { stdout, stderr, failed: error !== null },
            ),
          ),
      );
      child.stdin?.end('Synthetic fixture prompt');
    });
    return {
      ...result,
      candidate: await readFile(
        join(cwd, 'mock-kilo-result.txt'),
        'utf8',
      ).catch(() => null),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function parse(stdout: string) {
  if (!stdout.endsWith('\n'))
    throw new Error('Truncated synthetic Kilo stream');
  const events = new KiloEvents();
  for (const line of stdout.trimEnd().split('\n')) events.accept(line);
  return events;
}

// These exercise the separate fake executable/protocol. Shared-host lifecycle
// acceptance runs on Linux and must additionally establish signed death proof.
describe('synthetic Kilo executable protocol', () => {
  it('reads the explicitly synthetic tagged-source fixture', async () => {
    const fixture = await readFile(
      new URL('./kilo/fixtures/success.jsonl', import.meta.url),
      'utf8',
    );
    expect(parse(fixture).terminal).toBe('completed');
    expect(parse(fixture).sessionId).toBe('ses_synthetic_kilo');
  });
  it('emits independent fresh root sessions and a candidate from separate processes', async () => {
    const first = await fixture('success');
    const second = await fixture('success');
    expect(first.failed).toBe(false);
    expect(first.candidate).toBe('Synthetic Kilo factory candidate\n');
    expect(parse(first.stdout).terminal).toBe('completed');
    expect(parse(first.stdout).sessionId).not.toBe(
      parse(second.stdout).sessionId,
    );
  });
  it('preserves provider failure and nonzero exit separately', async () => {
    const failed = await fixture('failure');
    expect(failed.failed).toBe(true);
    expect(parse(failed.stdout).terminal).toBe('failed');
    const nonzero = await fixture('nonzero');
    expect(nonzero.failed).toBe(true);
    expect(parse(nonzero.stdout).terminal).toBe('completed');
    // A completed provider event does not override host exit/failure evidence.
  });
  it.each([
    'malformed',
    'oversized',
    'duplicate-terminal',
    'contradictory-terminal',
    'foreign-session',
  ])('rejects %s fake output', async (scenario) => {
    const result = await fixture(scenario);
    expect(() => parse(result.stdout)).toThrow('Invalid Kilo event stream');
  });
  it('leaves absent terminal output unresolved and rejects truncated framing', async () => {
    expect(
      parse((await fixture('absent-terminal')).stdout).terminal,
    ).toBeNull();
    expect(() => parse('partial')).toThrow('Truncated synthetic Kilo stream');
    const truncated = await fixture('truncated');
    expect(() => parse(truncated.stdout)).toThrow(
      'Truncated synthetic Kilo stream',
    );
  });
});
