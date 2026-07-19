import { randomBytes } from 'node:crypto';
import {
  fetchCheckSummary,
  fetchFailingCheckFacts,
  fetchPullRequestDetail,
  fetchPullRequestEventState,
} from '../../github';
import { buildMemoryPromptSnapshotSync } from '../../memory';
import {
  repoAutopilotPolicyForWatch,
  repoGuardrails,
} from '../../autopilot-policy';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import { readWorktreeRecord } from '../../worktrees';
import { readAutopilotReadiness, type AutopilotReadiness } from '../../runtime';
import { gitCurrentSha } from '../../../repo-edit/git';
import { openDb } from '../../../lib/sqlite';
import {
  parseAppConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../../runtime-home';
import type {
  AutopilotAdmission,
  AutopilotPrOwner,
  AutopilotStageAttempt,
} from '../coordination/schemas';
import { stableJsonHash } from './grounding';
import { autopilotOwnerPolicySnapshot } from './policy';

const maximumFactsBytes = 384 * 1024;
const maximumEnvelopeBytes = 512 * 1024;

export type OwnerEnvelopeFacts = {
  pullRequest: unknown;
  review: unknown;
  checks: unknown;
  failingChecks: unknown;
};

export type OwnerEnvelopeFactsLoader = (input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}) => Promise<OwnerEnvelopeFacts>;
export type OwnerEnvelopeReadinessLoader = (input: {
  repoId: string;
  prNumber: number;
  mode: Parameters<typeof readAutopilotReadiness>[0]['mode'];
}) => Promise<AutopilotReadiness>;
export type OwnerEnvelopeLocalShaLoader = (path: string) => Promise<string>;

export async function buildAutopilotOwnerEnvelope(
  input: {
    owner: AutopilotPrOwner;
    admission: AutopilotAdmission;
    attempt: AutopilotStageAttempt;
    generation: number;
    instanceId: string;
    grounding: {
      kind: string;
      reasons: string[];
      configHistoryId: number;
      memoryEventAt: string | null;
      memoryEventId: string | null;
      memoryEventRowId: number;
      memoryIds: string[];
    };
    submitToken?: string;
    factsLoader?: OwnerEnvelopeFactsLoader;
    readinessLoader?: OwnerEnvelopeReadinessLoader;
    localShaLoader?: OwnerEnvelopeLocalShaLoader;
  },
  paths: RuntimePaths,
) {
  if (!input.owner.worktreeId || !input.owner.currentHeadSha) {
    throw new Error('Owner dispatch requires a bound worktree and head SHA.');
  }
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === input.owner.repoId,
  );
  if (!repo)
    throw new Error(`Repository ${input.owner.repoId} is not configured.`);
  const worktree = readWorktreeRecord(input.owner.worktreeId, paths);
  if (
    worktree.repoId !== repo.id ||
    worktree.prNumber !== input.owner.prNumber
  ) {
    throw new Error('Owner worktree is outside the watched PR boundary.');
  }
  if (worktree.localPath === repo.path) {
    throw new Error('Owner dispatch may not target the primary checkout.');
  }
  if (
    !['ready', 'prepared-diff', 'succeeded'].includes(worktree.lifecycleStatus)
  ) {
    throw new Error(
      `Owner worktree is ${worktree.lifecycleStatus}; synchronize or recover it before dispatch.`,
    );
  }
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: input.owner.watchId,
    prNumber: input.owner.prNumber,
  });
  const guardrails = repoGuardrails(repo, appConfig);
  const effectivePolicy = autopilotOwnerPolicySnapshot({
    admissionMode: input.admission.mode,
    configuredMode: policy.mode,
    guardrails,
    executionPolicy: appConfig.execution ?? null,
    worktreePolicy: appConfig.worktrees ?? null,
    learningPolicy: appConfig.learning ?? null,
  });
  const [facts, readiness, localHeadSha] = await Promise.all([
    (input.factsLoader ?? loadOwnerFacts)({
      owner: repo.github.owner,
      repo: repo.github.name,
      prNumber: input.owner.prNumber,
      headSha: input.owner.currentHeadSha,
    }),
    (
      input.readinessLoader ??
      ((request) => readAutopilotReadiness(request, paths))
    )({
      repoId: repo.id,
      prNumber: input.owner.prNumber,
      mode: effectivePolicy.effectiveMode,
    }),
    (input.localShaLoader ?? gitCurrentSha)(worktree.localPath),
  ]);
  if (pullRequestHeadSha(facts.pullRequest) !== input.owner.currentHeadSha) {
    throw new Error('Live pull request head changed before owner dispatch.');
  }
  if (containsTruncation(facts)) {
    throw new Error(
      'Authoritative PR facts are truncated; owner dispatch is blocked.',
    );
  }
  const factsBytes = Buffer.byteLength(JSON.stringify(facts));
  if (factsBytes > maximumFactsBytes) {
    throw new Error(
      `Authoritative PR facts exceed the ${maximumFactsBytes}-byte owner envelope limit.`,
    );
  }
  const memory = buildMemoryPromptSnapshotSync(paths, { repoId: repo.id });
  const submitToken =
    input.submitToken ??
    `${input.attempt.id}.${randomBytes(24).toString('base64url')}`;
  const policySnapshot = { ...effectivePolicy, readiness };
  const policyHash = stableJsonHash(effectivePolicy);
  const continuity = loadOwnerContinuity(
    paths,
    input.owner.id,
    input.owner.watchId,
    input.admission.eventSequence,
  );
  const envelope = {
    schema: 'neondeck.autopilot-owner-envelope.v1',
    authority:
      'This envelope is authoritative for this turn. Prior transcript facts are historical context only.',
    identity: {
      ownerId: input.owner.id,
      watchId: input.owner.watchId,
      repoId: input.owner.repoId,
      repoFullName: repoFullName(repo),
      prNumber: input.owner.prNumber,
      admissionId: input.admission.id,
      eventFingerprint: input.admission.eventFingerprint,
      eventSequence: input.admission.eventSequence,
      attemptId: input.attempt.id,
      generation: input.generation,
      instanceId: input.instanceId,
    },
    request: {
      current: input.admission.input,
      coalescedEvents: input.admission.input.coalescedEvents ?? [],
    },
    facts,
    workspace: {
      worktreeId: worktree.id,
      repoFullName: worktree.repoFullName,
      githubOwner: worktree.githubOwner,
      githubName: worktree.githubName,
      prNumber: worktree.prNumber,
      baseRef: worktree.baseRef,
      headOwner: worktree.headOwner,
      headName: worktree.headName,
      lifecycleStatus: worktree.lifecycleStatus,
      localPath: worktree.localPath,
      sourceCheckoutPath: repo.path,
      primaryCheckoutMutationAllowed: false,
      checkoutMode: 'managed-pr-worktree',
      headRef: worktree.headRef,
      expectedPrHeadSha: input.owner.currentHeadSha,
      expectedWorktreeHeadSha: localHeadSha,
      lastSyncedSha: worktree.lastSyncedSha,
      directPushAllowed: worktree.directPushAllowed,
      intendedPushTarget: readiness.pushTarget,
      storageKind: worktree.storageKind,
      adopted: worktree.adopted,
      createdBy: worktree.createdBy,
    },
    policy: policySnapshot,
    continuity,
    grounding: {
      ...input.grounding,
      selectedMemoryIds: memory.memoryIds,
      memoryInstructions: memory.instructions,
    },
    capabilities: {
      allowed: [
        'neondeck_autopilot_file_read',
        'neondeck_autopilot_file_search',
        'neondeck_autopilot_diff',
        'neondeck_autopilot_checkout_status',
        'neondeck_autopilot_submit_fix',
      ],
      forbidden: [
        'shell',
        'raw repository mutation',
        'GitHub mutation',
        'push',
        'config mutation',
        'MCP',
        'subagents',
      ],
      submitFix: {
        token: submitToken,
        exactlyOnce: true,
        expectedAdmissionId: input.admission.id,
        expectedAttemptId: input.attempt.id,
        expectedWorktreeId: worktree.id,
        expectedPrHeadSha: input.owner.currentHeadSha,
        expectedWorktreeHeadSha: localHeadSha,
        policyHash,
      },
      reads: {
        attemptId: input.attempt.id,
        token: submitToken,
        repoIdBoundByTrustedAction: repo.id,
        worktreeIdBoundByTrustedAction: worktree.id,
      },
    },
    operatorInspection: {
      owner: `/api/autopilot/owners/${encodeURIComponent(input.owner.id)}`,
      admission: `/api/autopilot/admissions/${encodeURIComponent(input.admission.id)}`,
      agentHistory: `/api/flue/agents/pr-autopilot-owner/${encodeURIComponent(input.instanceId)}`,
      guardedByLocalApi: true,
    },
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > maximumEnvelopeBytes) {
    throw new Error(
      `Authoritative owner envelope exceeds the ${maximumEnvelopeBytes}-byte limit.`,
    );
  }
  return {
    envelope,
    serialized,
    envelopeHash: stableJsonHash(envelope),
    policyHash,
    submitToken,
    submitTokenHash: stableJsonHash(submitToken),
    selectedMemoryIds: memory.memoryIds,
    worktreeId: worktree.id,
    expectedPrHeadSha: input.owner.currentHeadSha,
    expectedWorktreeHeadSha: localHeadSha,
  };
}

function pullRequestHeadSha(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.headSha === 'string'
    ? record.headSha
    : typeof record.head_sha === 'string'
      ? record.head_sha
      : null;
}

function loadOwnerContinuity(
  paths: RuntimePaths,
  ownerId: string,
  watchId: string,
  eventSequence: number,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const previousOutcome = database
      .prepare(
        `SELECT id, event_fingerprint, event_sequence, state, prepared_diff_id,
                last_outcome_json, completed_at
         FROM autopilot_admissions
         WHERE owner_id = ? AND event_sequence < ?
         ORDER BY event_sequence DESC LIMIT 1;`,
      )
      .get(ownerId, eventSequence);
    const addressedFeedback = database
      .prepare(
        `SELECT category, watermark_json, updated_at
         FROM pr_watch_event_watermarks WHERE watch_id = ?
         ORDER BY category;`,
      )
      .all(watchId);
    const priorSubmissions = database
      .prepare(
        `SELECT admission_id, disposition, status, prepared_diff_id, error,
                created_at, finished_at
         FROM autopilot_owner_fix_submissions WHERE owner_id = ?
         ORDER BY created_at DESC LIMIT 8;`,
      )
      .all(ownerId);
    return {
      previousOutcome: previousOutcome ?? null,
      addressedFeedback,
      priorSubmissions,
    };
  } finally {
    database.close();
  }
}

async function loadOwnerFacts(input: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required for owner grounding.');
  const options = {
    token,
    owner: input.owner,
    repo: input.repo,
    number: input.prNumber,
  };
  const [pullRequest, review, checks, failingChecks] = await Promise.all([
    fetchPullRequestDetail(options),
    fetchPullRequestEventState(options),
    fetchCheckSummary({ ...options, ref: input.headSha }),
    fetchFailingCheckFacts({
      token,
      owner: input.owner,
      repo: input.repo,
      ref: input.headSha,
    }),
  ]);
  return { pullRequest, review, checks, failingChecks };
}

function containsTruncation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsTruncation);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.truncated === true ||
    record.complete === false ||
    Object.entries(record).some(
      ([key, item]) => key.toLowerCase().endsWith('truncated') && item === true,
    )
  )
    return true;
  return Object.values(record).some(containsTruncation);
}
