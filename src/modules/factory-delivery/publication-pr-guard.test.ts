import * as v from 'valibot';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliveryPipelineSchema } from '../../../shared/factory-delivery';
import type { GitHubConnection } from '../../../shared/factory-github';
import { runtimePaths } from '../../runtime-home';
import { clearGitHubRequestCache } from '../github';
import { assertPublicationPrPushAllowed } from './publication-pr-guard';

const mocks = vi.hoisted(() => ({
  authority: vi.fn<
    () => {
      connection: GitHubConnection;
      authority: {
        repo: { id: string; github: { owner: string; name: string } };
      };
    }
  >(),
}));
vi.mock('./authority', () => ({ assertDeliveryAuthority: mocks.authority }));
const connection: GitHubConnection = {
  id: 'synthetic',
  enabled: true,
  repoId: 'fixture',
  repositoryId: '42',
  owner: 'example',
  name: 'fixture',
  tokenEnv: 'SYNTHETIC_TOKEN',
  webhookSecretEnv: 'SYNTHETIC_SECRET',
  admission: { mode: 'all' },
};
const paths = runtimePaths('/tmp/synthetic-pr-guard');
const priorHead = 'e'.repeat(40);
function initialPipeline() {
  const time = '2026-09-06T00:00:00.000Z';
  const headSha = 'a'.repeat(40);
  const treeSha = 'b'.repeat(40);
  const revision = {
    runId: 'run',
    attemptId: 'attempt',
    releaseId: 'release',
    specVersion: 1,
    specHash: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    baseSha: headSha,
    headSha,
    treeSha,
  };
  return v.parse(deliveryPipelineSchema, {
    pipelineId: 'c'.repeat(64),
    version: 1,
    workItemId: 'work',
    repoId: 'fixture',
    initialRevision: revision,
    revision,
    branch: `agent/factory-${'c'.repeat(64)}`,
    prIdentity: 'synthetic-pr',
    pr: null,
    authorization: {
      id: 'grant',
      authorizedBy: 'operator',
      authorizedAt: time,
      revision,
      repoId: 'fixture',
      target: { owner: 'example', name: 'fixture', baseBranch: 'main' },
      configFingerprint: 'd'.repeat(64),
      checkCommands: ['check'],
      maxRepairAttempts: 2,
      totalExecutionMs: 10000,
      initialExecutionMs: 1,
    },
    repairs: [],
    feedback: [],
    evidence: [],
    effects: [
      {
        id: `commit:${revision.candidateDigest}`,
        kind: 'commit',
        revision,
        state: 'in-flight',
        receiptRef: null,
        reservedExecutionMs: null,
        executionMs: null,
      },
    ],
    interventions: [],
    commits: [],
    coordinator: {
      candidateRef: null,
      watchId: null,
      observationFingerprint: null,
      terminalObservedAt: null,
      watchObservedAt: null,
    },
    outcome: null,
    outcomeRef: null,
    createdAt: time,
    updatedAt: time,
  });
}
function fixture() {
  const pipeline = initialPipeline();
  pipeline.pr = { number: 7, url: 'https://github.com/example/fixture/pull/7' };
  pipeline.commits.push({
    revision: pipeline.revision,
    publishedHeadSha: priorHead,
    treeSha: pipeline.revision.treeSha,
    evidenceRef: 'synthetic-receipt',
  });
  pipeline.revision = { ...pipeline.revision, candidateDigest: 'f'.repeat(64) };
  const repo = { id: 42, name: 'fixture', owner: { login: 'example' } };
  const pull = {
    id: 101,
    number: 7,
    html_url: pipeline.pr.url,
    title: 'Synthetic repair',
    body: `<!-- neon-factory-pr:${pipeline.pipelineId} -->`,
    state: 'open',
    draft: true,
    head: { ref: pipeline.branch, sha: priorHead, repo },
    base: { ref: 'main', sha: 'b'.repeat(40), repo },
    user: { id: 4, login: 'synthetic-bot' },
    merged_at: null,
    merge_commit_sha: null,
    updated_at: '2026-09-06T00:00:00Z',
    merged: false,
    mergeable: null,
    mergeable_state: 'unknown',
  };
  const push = vi.fn<() => Promise<void>>(async () => {});
  const guardedPush = async (expected: string | null = priorHead) => {
    await assertPublicationPrPushAllowed(pipeline, expected, paths);
    await push();
  };
  return { pipeline, pull, push, guardedPush };
}
function reply(body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () => Response.json(body));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
beforeEach(() => {
  clearGitHubRequestCache();
  vi.stubEnv('SYNTHETIC_TOKEN', 'synthetic-test-value');
  mocks.authority.mockReset();
  mocks.authority.mockReturnValue({
    connection: { ...connection },
    authority: {
      repo: { id: 'fixture', github: { owner: 'example', name: 'fixture' } },
    },
  });
});
afterEach(() => {
  clearGitHubRequestCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('allows the exact prior head on the bound open draft after a fresh GET', async () => {
  const f = fixture();
  const fetchMock = reply(f.pull);
  await f.guardedPush();
  expect(f.push).toHaveBeenCalledOnce();
  expect(mocks.authority).toHaveBeenCalledWith(f.pipeline, paths);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    'https://api.github.com/repos/example/fixture/pulls/7',
  );
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    cache: 'no-cache',
    signal: expect.any(AbortSignal),
  });
});
it.each([
  [
    'missing marker',
    (p: ReturnType<typeof fixture>['pull']) => ({ ...p, body: '' }),
  ],
  [
    'duplicate marker',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      body: `${p.body}\n${p.body}`,
    }),
  ],
  [
    'retargeted base',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      base: { ...p.base, ref: 'other' },
    }),
  ],
  [
    'closed',
    (p: ReturnType<typeof fixture>['pull']) => ({ ...p, state: 'closed' }),
  ],
  [
    'ready for review',
    (p: ReturnType<typeof fixture>['pull']) => ({ ...p, draft: false }),
  ],
  [
    'foreign head',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      head: { ...p.head, sha: 'f'.repeat(40) },
    }),
  ],
  [
    'foreign head repository',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      head: { ...p.head, repo: { ...p.head.repo, id: 99 } },
    }),
  ],
  [
    'foreign base repository',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      base: { ...p.base, repo: { ...p.base.repo, name: 'other' } },
    }),
  ],
  [
    'merged',
    (p: ReturnType<typeof fixture>['pull']) => ({
      ...p,
      state: 'closed',
      merged: true,
      merged_at: '2026-09-06T00:00:00Z',
    }),
  ],
  [
    'missing draft data',
    (p: ReturnType<typeof fixture>['pull']) => ({ ...p, draft: undefined }),
  ],
  [
    'wrong PR number',
    (p: ReturnType<typeof fixture>['pull']) => ({ ...p, number: 8 }),
  ],
])('does not push after %s', async (_name, changed) => {
  const f = fixture();
  reply(changed(f.pull));
  await expect(f.guardedPush()).rejects.toThrow(/.+/);
  expect(f.push).not.toHaveBeenCalled();
});
it('does not push when the bound PR URL conflicts', async () => {
  const f = fixture();
  reply(f.pull);
  f.pipeline.pr = {
    number: 7,
    url: 'https://github.com/example/fixture/pull/8',
  };
  await expect(f.guardedPush()).rejects.toThrow('exact open draft');
  expect(f.push).not.toHaveBeenCalled();
});
it.each([null, 'f'.repeat(40), 'invalid'])(
  'rejects an unbound expected prior head %s before network',
  async (expected) => {
    const f = fixture();
    const fetchMock = reply(f.pull);
    await expect(f.guardedPush(expected)).rejects.toThrow(/.+/);
    expect(f.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);
it('rejects source configuration drift before network', async () => {
  const f = fixture();
  const fetchMock = reply(f.pull);
  mocks.authority.mockReturnValue({
    connection,
    authority: {
      repo: { id: 'fixture', github: { owner: 'other', name: 'fixture' } },
    },
  });
  await expect(f.guardedPush()).rejects.toThrow(
    'source repository configuration changed',
  );
  expect(f.push).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('propagates revoked authority without pushing', async () => {
  const f = fixture();
  const fetchMock = reply(f.pull);
  mocks.authority.mockImplementation(() => {
    throw new Error('grant revoked');
  });
  await expect(f.guardedPush()).rejects.toThrow('grant revoked');
  expect(f.push).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('fails closed on unavailable provider data without a push', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(
      async () => new Response('unavailable', { status: 503 }),
    ),
  );
  await expect(f.guardedPush()).rejects.toThrow(/.+/);
  expect(f.push).not.toHaveBeenCalled();
});
it('leaves an initial unbound PR to the branch lease without a GitHub request', async () => {
  const f = fixture();
  f.pipeline.pr = null;
  const fetchMock = reply(f.pull);
  await f.guardedPush(null);
  expect(f.push).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.authority).not.toHaveBeenCalled();
});
