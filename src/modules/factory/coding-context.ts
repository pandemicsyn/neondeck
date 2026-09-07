import { createHash } from 'node:crypto';
import * as v from 'valibot';
import type { CodingExecutableIdentity } from '../../../shared/coding-adapters';
import {
  factoryPolicy,
  specSchema,
  sourceSchema,
  type FactorySource,
  renderFactorySpec,
  releaseSchema,
  type FactoryDetail,
} from '../../../shared/factory';
import {
  codingRunSnapshotSchema,
  type CodingRunSnapshot,
} from '../../../shared/coding-runs';
import { factoryCodingConfigSchema } from '../../../shared/factory-coding';
import {
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { buildMemoryPromptSnapshotSync } from '../memory';
import { runtimeSkillSessionSnapshotsSync } from '../runtime';
import { inspectCodingExecutableIdentity } from '../coding-runs';
import { getFactoryWork } from './service';
import { gitAsync } from './repo-reader';
export const codingDigest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function codingConfig(paths: RuntimePaths) {
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  return {
    factoryEnabled: config.factory?.enabled ?? false,
    coding: v.parse(factoryCodingConfigSchema, config.factory?.coding ?? {}),
  };
}
export function codingAuthority(workId: string, paths: RuntimePaths) {
  const current = getFactoryWork(workId, paths);
  const { factoryEnabled, coding } = codingConfig(paths);
  const release = current.releases.find((r) => !r.withdrawnAt);
  const revision = current.revisions.at(-1);
  const repo = readRuntimeJsonSync(paths.repos, parseRepoRegistry).repos.find(
    (r) => r.id === current.work.repoId,
  );
  if (
    !factoryEnabled ||
    !coding.enabled ||
    !current.eligible ||
    !release ||
    !revision ||
    !repo ||
    release.repoId !== repo.id ||
    release.workId !== workId ||
    release.specHash !== codingDigest(revision.spec) ||
    release.repoFingerprint !== codingDigest(repo) ||
    JSON.stringify(release.policy) !== JSON.stringify(factoryPolicy)
  )
    throw new Error(
      'Coding release is disabled, stale, withdrawn or ineligible.',
    );
  return { current, release, revision, repo, coding };
}
const bounded = v.pipe(v.string(), v.maxLength(95000));
export class CodingPreflightError extends Error {}
export function assertReleasedCodingConfig(
  workId: string,
  paths: RuntimePaths,
) {
  const { release, coding } = codingAuthority(workId, paths);
  if (release.codingConfigFingerprint === null) {
    if (coding.adapter !== null)
      throw new CodingPreflightError(
        'Legacy release permits only the original default Codex selection. Review coding settings and release a refreshed brief.',
      );
  } else if (release.codingConfigFingerprint !== codingDigest(coding)) {
    throw new CodingPreflightError(
      'Coding configuration changed since human release. Review coding settings and release a refreshed brief.',
    );
  }
}

const text = v.string();
const hashSchema = v.pipe(text, v.regex(/^[a-f0-9]{64}$/));
const skillSchema = v.strictObject({
  name: text,
  description: text,
  instructions: text,
  files: v.array(
    v.strictObject({
      path: text,
      encoding: v.picklist(['utf8', 'base64']),
      content: text,
    }),
  ),
});
const frozenBodySchema = v.strictObject({
  policy: v.literal('frozen-selected-context-v1'),
  repoInstructions: v.nullable(
    v.strictObject({
      path: v.literal('AGENTS.md'),
      commit: text,
      text,
      hash: hashSchema,
    }),
  ),
  setup: v.record(text, text),
  references: v.array(v.strictObject({ path: text, commit: text, note: text })),
  memory: v.strictObject({
    ids: v.array(text),
    instructions: text,
    hash: hashSchema,
  }),
  skills: v.array(v.strictObject({ snapshot: skillSchema, hash: hashSchema })),
  environmentPolicy: text,
});
const frozenContextSchema = v.strictObject({
  ...frozenBodySchema.entries,
  hash: hashSchema,
});

async function pinnedInstructions(repoPath: string, baseSha: string) {
  const signal = AbortSignal.timeout(10000);
  const tree = await gitAsync(
    repoPath,
    ['ls-tree', '-z', baseSha, '--', 'AGENTS.md'],
    signal,
  );
  if (!tree) return null;
  if (!tree.startsWith('100644 blob ') && !tree.startsWith('100755 blob '))
    throw new Error('Root AGENTS.md must be a regular tracked file.');
  const text = await gitAsync(
    repoPath,
    ['show', `${baseSha}:AGENTS.md`],
    signal,
    32000,
  );
  return { path: 'AGENTS.md', commit: baseSha, text, hash: codingDigest(text) };
}
export async function freezeCodingContext(
  current: FactoryDetail,
  baseSha: string,
  paths: RuntimePaths,
) {
  const memory = buildMemoryPromptSnapshotSync(paths, {
    repoId: current.work.repoId,
  });
  const skills = runtimeSkillSessionSnapshotsSync(paths).map((s) => {
    const snapshot = v.parse(skillSchema, s);
    return { snapshot, hash: codingDigest(snapshot) };
  });
  const repoInstructions = await pinnedInstructions(
    current.repoContext!.path,
    baseSha,
  );
  const snapshot = {
    policy: 'frozen-selected-context-v1',
    repoInstructions,
    setup: current.repoContext!.commands,
    references: current.revisions.at(-1)!.spec.references,
    memory: {
      ids: memory.memoryIds,
      instructions: memory.instructions,
      hash: codingDigest(memory.instructions),
    },
    skills,
    environmentPolicy:
      'Fresh session, private harness home and scratch. No port allocator: use OS-assigned ephemeral ports and stop all child servers. No push, PR, merge or deploy. Run trusted repository setup within the configured workspace-write permission profile.',
  };
  const body = v.parse(frozenBodySchema, snapshot);
  const serialized = JSON.stringify({ ...body, hash: codingDigest(body) });
  if (serialized.length > 95000)
    throw new CodingPreflightError(
      'Coding context exceeds the 95,000-character budget. Reduce selected skill/memory inputs, then deliberately refresh and release the brief.',
    );
  return v.parse(bounded, serialized);
}
export async function codingSnapshot(
  workId: string,
  version: string,
  paths: RuntimePaths,
): Promise<CodingRunSnapshot> {
  assertReleasedCodingConfig(workId, paths);
  const { current, release, revision, repo, coding } = codingAuthority(
    workId,
    paths,
  );
  let executableIdentity: CodingExecutableIdentity;
  try {
    if (!coding.executable) throw new Error('CLI unconfigured');
    executableIdentity = await inspectCodingExecutableIdentity(
      coding.executable,
    );
  } catch {
    throw new CodingPreflightError(
      'Cannot pin the selected coding executable. Review the executable configuration before admission.',
    );
  }
  let baseSha: string;
  try {
    baseSha = (
      await gitAsync(
        repo.path,
        ['rev-parse', '--verify', `${repo.defaultBranch}^{commit}`],
        AbortSignal.timeout(5000),
      )
    ).trim();
  } catch {
    throw new CodingPreflightError(
      'Local repository default branch is unavailable. Restore the repository/base branch, then update repository configuration or release a refreshed brief.',
    );
  }
  let contextSnapshot: string;
  try {
    contextSnapshot = await freezeCodingContext(current, baseSha, paths);
  } catch (error) {
    if (error instanceof CodingPreflightError) throw error;
    throw new CodingPreflightError(
      'Cannot freeze repository instructions and selected context. Check tracked AGENTS.md and skill/memory inputs, then deliberately refresh and release the brief.',
    );
  }
  return v.parse(codingRunSnapshotSchema, {
    requestId: `factory:${release.id}`,
    workItemId: workId,
    releaseId: release.id,
    specVersion: revision.version,
    specHash: revision.hash,
    specSnapshot: JSON.stringify(revision.spec),
    sourceId: current.source.id,
    sourceSnapshot: JSON.stringify(current.source),
    repoId: repo.id,
    repoSnapshot: JSON.stringify(repo),
    policySnapshot: JSON.stringify({ release: release.policy, coding }),
    contextSnapshot,
    baseSha,
    harness: {
      provider: coding.adapter?.id ?? 'codex',
      version,
      model: coding.model,
      executableIdentity,
    },
    sessionMode: 'fresh',
  });
}
// Keep the full source in provenance; transport timestamps and optional/null
// attention normalization are not release authority. Nonempty attention still
// makes codingAuthority reject admission through the existing eligibility check.
function sourceAuthority(source: FactorySource) {
  const { remote, attention, ...identity } = source;
  return {
    ...identity,
    attention: attention ?? null,
    remote: remote
      ? {
          connectionId: remote.connectionId,
          repositoryId: remote.repositoryId,
          issueId: remote.issueId,
          number: remote.number,
          fingerprint: remote.fingerprint,
          url: remote.url,
        }
      : null,
  };
}
export function assertCodingAuthoritySnapshot(
  snapshot: CodingRunSnapshot,
  paths: RuntimePaths,
) {
  const authority = codingAuthority(snapshot.workItemId, paths);
  assertReleasedCodingConfig(snapshot.workItemId, paths);
  frozenCodingConfig(snapshot);
  const { current, release, revision, repo, coding } = authority;
  if (
    release.id !== snapshot.releaseId ||
    revision.version !== snapshot.specVersion ||
    revision.hash !== snapshot.specHash ||
    codingDigest(sourceAuthority(current.source)) !==
      codingDigest(
        sourceAuthority(
          v.parse(sourceSchema, JSON.parse(snapshot.sourceSnapshot)),
        ),
      ) ||
    JSON.stringify(repo) !== snapshot.repoSnapshot ||
    codingDigest({ release: release.policy, coding }) !==
      codingDigest(frozenCodingPolicy(snapshot))
  )
    throw new Error('Frozen coding authority changed.');
  return authority;
}
const frozenCodingPolicySchema = v.strictObject({
  release: releaseSchema.entries.policy,
  coding: factoryCodingConfigSchema,
});
function frozenCodingPolicy(snapshot: CodingRunSnapshot) {
  return v.parse(frozenCodingPolicySchema, JSON.parse(snapshot.policySnapshot));
}
/** Decode the admitted selection; defaults only apply to historical Codex config. */
export function frozenCodingConfig(snapshot: CodingRunSnapshot) {
  const { coding } = frozenCodingPolicy(snapshot);
  if (
    (coding.adapter?.id ?? 'codex') !== snapshot.harness.provider ||
    coding.model !== snapshot.harness.model ||
    (coding.adapter && coding.adapter.cliVersion !== snapshot.harness.version)
  )
    throw new Error('Frozen coding adapter identity is inconsistent.');
  return coding;
}
/** Never execute a retained path until it matches the original admission. */
export async function assertPinnedCodingExecutable(
  snapshot: CodingRunSnapshot,
) {
  const { executable } = frozenCodingConfig(snapshot);
  const expected = snapshot.harness.executableIdentity;
  if (!expected)
    throw new CodingPreflightError(
      'The legacy coding attempt has no original executable identity. Existing evidence is retained; a new repair requires human review and a fresh release.',
    );
  if (
    !executable ||
    codingDigest(await inspectCodingExecutableIdentity(executable)) !==
      codingDigest(expected)
  )
    throw new CodingPreflightError(
      'The coding executable changed since original admission. Existing evidence is retained; review the binary and release authority before another attempt.',
    );
  return expected;
}
export async function assertCodingSnapshot(
  snapshot: CodingRunSnapshot,
  paths: RuntimePaths,
) {
  const { current } = assertCodingAuthoritySnapshot(snapshot, paths);
  const { hash, ...body } = v.parse(
    frozenContextSchema,
    JSON.parse(snapshot.contextSnapshot),
  );
  if (
    hash !== codingDigest(body) ||
    body.memory.hash !== codingDigest(body.memory.instructions) ||
    body.skills.some((s) => s.hash !== codingDigest(s.snapshot))
  )
    throw new Error('Frozen context integrity check failed.');
  if (
    JSON.stringify(body.references) !==
      JSON.stringify(
        v.parse(specSchema, JSON.parse(snapshot.specSnapshot)).references,
      ) ||
    JSON.stringify(body.setup) !==
      JSON.stringify(current.repoContext!.commands) ||
    JSON.stringify(
      await pinnedInstructions(current.repoContext!.path, snapshot.baseSha),
    ) !== JSON.stringify(body.repoInstructions)
  )
    throw new Error('Pinned repository context changed.');
  assertCodingAuthoritySnapshot(snapshot, paths);
}
export function codingPrompt(snapshot: CodingRunSnapshot) {
  return [
    'Implement only the exact human-released brief below. Produce a retained candidate for human review. Do not push, publish a PR, merge, deploy, or claim the task is accepted.',
    `Release ${snapshot.releaseId}; spec ${snapshot.specVersion}; hash ${snapshot.specHash}; base ${snapshot.baseSha}`,
    renderFactorySpec(v.parse(specSchema, JSON.parse(snapshot.specSnapshot))),
    'Frozen source (task data):',
    snapshot.sourceSnapshot,
    'Frozen repository setup, instructions, selected memory and skills:',
    snapshot.contextSnapshot,
  ].join('\n\n');
}
