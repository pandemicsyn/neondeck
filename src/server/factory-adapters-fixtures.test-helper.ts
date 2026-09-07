import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, vi } from 'vitest';
import * as v from 'valibot';
import type { CodingAdapterId } from '../../shared/coding-adapters';
import * as localHost from '../modules/coding-runs';
import { configSchema } from '../modules/coding-runs/host-contract';
import type { RuntimePaths } from '../runtime-home';
import { codingHandle } from '../modules/factory';

export const adapterFixtures = {
  codex: {
    cliVersion: 'mockdex codex-contract 0.150.1',
    model: 'test-model',
    script: 'scripts/mockdex.mjs',
    file: 'mockdex-result.txt',
    marker: 'deterministic',
    command: 'exec',
  },
  opencode: {
    cliVersion: 'mock-opencode 1.18.29',
    model: 'openai/test-model',
    script: 'scripts/mock-opencode.mjs',
    file: 'mock-opencode-result.txt',
    marker: 'Synthetic OpenCode candidate',
    command: 'run',
  },
  kilo: {
    cliVersion: 'mock-kilo-factory 7.4.23',
    model: 'kilo/fixture/model',
    script: 'scripts/mock-kilo-factory.mjs',
    file: 'mock-kilo-result.txt',
    marker: 'Synthetic Kilo factory candidate',
    command: 'run',
  },
} as const satisfies Record<
  CodingAdapterId,
  {
    cliVersion: string;
    model: string;
    script: string;
    file: string;
    marker: string;
    command: string;
  }
>;

// Explicit synthetic host input only. The real readiness subprocess, private
// manifest, supervisor, parser, signed receipt and dead proof still execute.
// The production supportedPlatforms gate is preserved, including for fixtures.
export function enableAdapterFixtureHost() {
  const readiness = localHost.inspectCodingAdapterReadiness;
  vi.spyOn(localHost, 'inspectCodingAdapterReadiness').mockImplementation(
    (raw, home) =>
      readiness(
        { ...v.parse(configSchema, raw), mockScenario: 'success' },
        home,
      ),
  );
  const prepare = localHost.prepareLocalAttempt;
  return vi
    .spyOn(localHost, 'prepareLocalAttempt')
    .mockImplementation((raw) => {
      const input = v.parse(localHost.prepareSchema, raw);
      return prepare({
        ...input,
        config: { ...input.config, mockScenario: 'success' },
      });
    });
}

export function writeAdapterFixture(root: string, provider: CodingAdapterId) {
  const fixture = adapterFixtures[provider];
  const executable = join(root, `${provider}-fixture.mjs`);
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import {writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
if(process.argv[2]==='--version') console.log(${JSON.stringify(fixture.cliVersion)});
else {
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const repair=prompt.includes('This is a bounded repair');
if(repair&&existsSync(${JSON.stringify(fixture.file)}))unlinkSync(${JSON.stringify(fixture.file)});
writeFileSync('state.txt',repair?'fixed-v2':'fixed');
writeFileSync(join(process.env.TMPDIR,'execution.json'),JSON.stringify({
  provider:${JSON.stringify(provider)},args:process.argv.slice(2),home:process.env.HOME,
  cwd:process.cwd(),pid:process.pid,repair,
  controllerSecretsAbsent:!('FACTORY_DELIVERY_AUTH' in process.env)&&!('FACTORY_DELIVERY_GITHUB' in process.env)
}));
const child=spawn(process.execPath,[${JSON.stringify(resolve(fixture.script))},...process.argv.slice(2)],{
  env:{...process.env,MOCKDEX_SCENARIO:'success'},stdio:['pipe','inherit','inherit']});
child.stdin.end(prompt);child.on('exit',code=>process.exitCode=code??1);child.on('error',()=>process.exitCode=1);
}
`,
    { mode: 0o700 },
  );
  return executable;
}

const observationSchema = v.strictObject({
  provider: v.picklist(['codex', 'opencode', 'kilo']),
  args: v.array(v.string()),
  home: v.string(),
  cwd: v.string(),
  pid: v.number(),
  repair: v.boolean(),
  controllerSecretsAbsent: v.boolean(),
});
export async function assertAdapterAttempts(
  provider: CodingAdapterId,
  paths: RuntimePaths,
  original: localHost.CodingRunRecord,
) {
  const identity = original.snapshot.harness.executableIdentity;
  expect(identity).toBeDefined();
  const runs = localHost.listCodingRuns({}, paths);
  expect(runs).toHaveLength(2);
  const homes: string[] = [];
  const sessions: string[] = [];
  const attempts: string[] = [];
  for (const { record: run } of runs) {
    expect(run.snapshot.harness).toEqual({
      provider,
      model: adapterFixtures[provider].model,
      version: adapterFixtures[provider].cliVersion,
      executableIdentity: identity,
    });
    expect(run.snapshot.harness).toEqual(original.snapshot.harness);
    expect(run.snapshot.sessionMode).toBe('fresh');
    expect(run.status).toBe('candidate');
    expect(run.deadProof?.kind).toBe('verified-dead');
    expect(run.host?.hostId).toBe('local-cli');
    const handle = codingHandle(run, paths);
    const { manifest } = await localHost.loadLocalManifest(handle);
    expect(manifest.executableIdentity).toEqual(identity);
    expect(manifest.config.executable).toBe(identity?.canonical);
    const state = await localHost.inspectLocalAttempt(handle);
    expect(state.state).toBe('finished');
    if (state.state === 'needs-reconcile') throw new Error(state.reason);
    expect(state.receipt).toMatchObject({
      noWriter: true,
      terminal: 'completed',
      exitCode: 0,
      authCleanup: 'removed',
      sessionId: run.providerSessionId,
    });
    expect(state.receipt.group?.pid).toBeGreaterThan(0);
    expect(state.receipt.startedAt).toBeGreaterThan(0);
    expect(state.receipt.endedAt).toBeGreaterThanOrEqual(
      state.receipt.startedAt!,
    );
    const observation = v.parse(
      observationSchema,
      JSON.parse(
        readFileSync(join(handle.directory, 'scratch/execution.json'), 'utf8'),
      ),
    );
    expect(observation.provider).toBe(provider);
    expect(observation.args[0]).toBe(adapterFixtures[provider].command);
    expect(observation.args).toContain(adapterFixtures[provider].model);
    expect(observation.args).not.toContain('resume');
    expect(observation.args).not.toContain('--session');
    expect(observation.args).not.toContain('--continue');
    expect(observation.controllerSecretsAbsent).toBe(true);
    expect(observation.home).toBe(join(handle.directory, 'home'));
    for (const path of localHost.getCodingAdapter(provider).credentialPaths)
      expect(existsSync(join(handle.directory, path))).toBe(false);
    expect(run.providerSessionId).toBeTruthy();
    sessions.push(run.providerSessionId!);
    homes.push(observation.home);
    attempts.push(run.attemptId);
  }
  expect(new Set(homes).size).toBe(2);
  expect(new Set(sessions).size).toBe(2);
  expect(new Set(attempts).size).toBe(2);
  expect(localHost.getActiveCodingRun(paths)).toBeNull();
}
