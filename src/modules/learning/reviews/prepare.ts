import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { readAutomationHealth } from '../automation-health';
import { readAgentModelSelectionSync } from '../../runtime';
import {
  referenceChatSession,
  readNeonSessionState,
  refreshChatSessionSummary,
  type ChatSessionRecord,
} from '../../sessions';
import { listMemoryEvents } from '../../memory';
import { ensureRuntimeHome, runtimePaths } from '../../../runtime-home';
import type {
  ConversationReviewInput,
  CurationReviewInput,
  FailedLearningReview,
  PrBatchReviewInput,
  PreparedLearningReview,
} from './schemas';
import {
  conversationReviewInputSchema,
  curationReviewInputSchema,
  prBatchReviewInputSchema,
} from './schemas';
import {
  compactJson,
  failedReview,
  startLearningReview,
  truncate,
} from './store';
import {
  conversationProjectRepoIds,
  learningPrompt,
  listActiveLearningMemories,
  listConversationLearningMemories,
  projectRepoIdsFromMemories,
  readLearningConfig,
  readSessionForReview,
  summarizeMemories,
  uniqueRepoIds,
} from './context';
import {
  listHandledPrEventsForReview,
  listPrLearningMemories,
  listRelatedKiloResultSummaries,
  listRelatedNotificationSummaries,
  listRelatedPreparedDiffSummaries,
  listRelatedVerificationSummaries,
  listRelatedWorkflowSummaries,
  readLearningSkillSnippets,
  summarizeHandledPrEvent,
} from './pr-context';

const memoryEventEvidenceSchema = v.array(
  v.object({
    action: v.optional(v.nullable(v.string())),
    memoryId: v.optional(v.nullable(v.string())),
    reason: v.optional(v.nullable(v.string())),
    createdAt: v.optional(v.nullable(v.string())),
  }),
);

export async function prepareConversationReflection(
  input: ConversationReviewInput = {},
  paths = runtimePaths(),
  options: { reviewId?: string } = {},
): Promise<PreparedLearningReview | FailedLearningReview> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(conversationReviewInputSchema, input);
  if (!parsed.success) {
    return failedReview(
      'learning_review_conversation',
      v.summarize(parsed.issues),
    );
  }
  const configResult = await readLearningConfig(paths);
  if (!configResult.ok) {
    return failedReview('learning_review_conversation', configResult.message, [
      'valid-learning-config',
    ]);
  }
  const config = configResult.config;
  if (!config.enabled) {
    return failedReview(
      'learning_review_conversation',
      'Learning is disabled; conversation reflection is blocked.',
      ['learning-enabled'],
    );
  }

  const session = parsed.output.sessionId
    ? await readSessionForReview(parsed.output.sessionId, paths)
    : (await readNeonSessionState(paths)).activeChatSession;
  const refreshed = await refreshChatSessionSummary(
    {
      id: session.id,
      reason: parsed.output.reason ?? 'conversation-learning-review',
      surface: 'learning',
    },
    paths,
  );
  const reviewedSession =
    // SAFETY: refreshChatSessionSummary returns its persisted session when refresh succeeds.
    (refreshed as { session?: ChatSessionRecord }).session ?? session;
  const reference = await referenceChatSession(
    {
      id: reviewedSession.id,
      reason: parsed.output.reason ?? 'conversation-learning-review',
      surface: 'learning',
    },
    paths,
  );
  const memories = await listConversationLearningMemories(
    reviewedSession,
    paths,
  );
  const skillSnippets = await readLearningSkillSnippets(paths);
  const models = readAgentModelSelectionSync(paths);
  const inputSummary = compactJson({
    kind: 'conversation',
    trigger: parsed.output.trigger ?? 'manual',
    reason: parsed.output.reason ?? null,
    turnCount: parsed.output.turnCount ?? null,
    policy: {
      memoryWriteMode: config.memoryWriteMode,
      skillWriteMode: config.skillWriteMode,
      maxRecentTurns: config.maxRecentTurns,
      transcriptSource: 'session-summary-metadata',
    },
    session: {
      id: reviewedSession.id,
      title: reviewedSession.title,
      kind: reviewedSession.kind,
      linkedRepoId: reviewedSession.linkedRepoId,
      linkedWatchId: reviewedSession.linkedWatchId,
      linkedTaskId: reviewedSession.linkedTaskId,
      uiMetadata: reviewedSession.uiMetadata,
      summary: truncate(reviewedSession.summary ?? '', 2_000),
      summarySource: reviewedSession.summarySource,
      staleReasons: reviewedSession.staleReasons,
      contextMemoryIds: reviewedSession.contextMemoryIds,
      transcriptUnavailable:
        // SAFETY: referenceChatSession's reference payload is produced by the local sessions adapter.
        (reference as { reference?: { transcript?: { available: boolean } } })
          .reference?.transcript?.available === false,
    },
    activeMemories: summarizeMemories(memories),
    skillSnippets,
  });
  const reviewId = options.reviewId ?? randomUUID();
  const prepared: PreparedLearningReview = {
    ok: true,
    reviewId,
    kind: 'conversation',
    mode: config.memoryWriteMode,
    skillMode: config.skillWriteMode,
    model: models.selfImprovement,
    thinkingLevel: models.selfImprovementThinkingLevel,
    inputSummary,
    prompt: learningPrompt(
      'conversation',
      inputSummary,
      config.memoryWriteMode,
    ),
    allowedMemoryIds: memories.map((memory) => memory.id),
    memorySnapshots: learningMemorySnapshots(memories),
    allowedProjectRepoIds: conversationProjectRepoIds(
      reviewedSession,
      memories,
    ),
    allowedSkillIds: skillSnippets.map((skill) => skill.id),
    skillSnapshots: learningSkillSnapshots(skillSnippets),
  };
  startLearningReview(
    {
      id: reviewId,
      kind: 'conversation',
      model: models.selfImprovement,
      thinkingLevel: models.selfImprovementThinkingLevel,
      trigger: {
        type: parsed.output.trigger ?? 'manual',
        sessionId: reviewedSession.id,
        turnCount: parsed.output.turnCount ?? null,
      },
      inputSummary,
      prepared,
      agentId: `learning-review:${reviewId}`,
    },
    paths,
  );
  return prepared;
}

export async function prepareMemoryCurationReview(
  input: CurationReviewInput = {},
  paths = runtimePaths(),
  options: { reviewId?: string } = {},
): Promise<PreparedLearningReview | FailedLearningReview> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(curationReviewInputSchema, input);
  if (!parsed.success) {
    return failedReview('learning_curate', v.summarize(parsed.issues));
  }
  const configResult = await readLearningConfig(paths);
  if (!configResult.ok) {
    return failedReview('learning_curate', configResult.message, [
      'valid-learning-config',
    ]);
  }
  const config = configResult.config;
  const mode = parsed.output.mode ?? config.memoryCurationMode;
  const trigger = parsed.output.trigger ?? 'manual';
  if (!config.enabled) {
    return failedReview(
      'learning_curate',
      'Learning is disabled; memory curation is blocked.',
      ['learning-enabled'],
    );
  }
  if (
    trigger !== 'manual' &&
    (!config.memoryCurationEnabled || mode === 'off')
  ) {
    return failedReview(
      'learning_curate',
      'Automatic memory curation is disabled.',
    );
  }
  if (mode === 'off') {
    return failedReview('learning_curate', 'Memory curation mode is off.');
  }

  const memories = await listActiveLearningMemories(paths);
  const events = await listMemoryEvents({ limit: 40 }, paths);
  const skillSnippets = await readLearningSkillSnippets(paths);
  const models = readAgentModelSelectionSync(paths);
  const inputSummary = compactJson({
    kind: 'curation',
    trigger,
    reason: parsed.output.reason ?? null,
    turnCount: parsed.output.turnCount ?? null,
    policy: {
      memoryCurationMode: mode,
      memoryWriteMode: config.memoryWriteMode,
      memoryMaxActiveItems: config.memoryMaxActiveItems,
    },
    activeMemories: summarizeMemories(memories, 160),
    recentMemoryEvents: v
      .parse(memoryEventEvidenceSchema, events.events)
      .map((event) => ({
        action: event.action,
        memoryId: event.memoryId,
        reason: truncate(String(event.reason ?? ''), 240),
        createdAt: event.createdAt,
      })),
    skillSnippets,
  });
  const reviewId = options.reviewId ?? randomUUID();
  const prepared: PreparedLearningReview = {
    ok: true,
    reviewId,
    kind: 'curation',
    mode,
    skillMode: config.skillWriteMode,
    model: models.selfImprovement,
    thinkingLevel: models.selfImprovementThinkingLevel,
    inputSummary,
    prompt: learningPrompt('curation', inputSummary, mode),
    allowedMemoryIds: memories.map((memory) => memory.id),
    memorySnapshots: learningMemorySnapshots(memories),
    allowedProjectRepoIds: projectRepoIdsFromMemories(memories),
    allowedSkillIds: skillSnippets.map((skill) => skill.id),
    skillSnapshots: learningSkillSnapshots(skillSnippets),
  };
  startLearningReview(
    {
      id: reviewId,
      kind: 'curation',
      model: models.selfImprovement,
      thinkingLevel: models.selfImprovementThinkingLevel,
      trigger: {
        type: trigger,
        mode,
        turnCount: parsed.output.turnCount ?? null,
      },
      inputSummary,
      prepared,
      agentId: `learning-review:${reviewId}`,
    },
    paths,
  );
  return prepared;
}

export async function preparePrBatchLearningReview(
  input: PrBatchReviewInput = {},
  paths = runtimePaths(),
  options: { reviewId?: string } = {},
): Promise<PreparedLearningReview | FailedLearningReview> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prBatchReviewInputSchema, input);
  if (!parsed.success) {
    return failedReview('learning_review_pr_batch', v.summarize(parsed.issues));
  }
  const configResult = await readLearningConfig(paths);
  if (!configResult.ok) {
    return failedReview('learning_review_pr_batch', configResult.message, [
      'valid-learning-config',
    ]);
  }
  const config = configResult.config;
  if (!config.enabled) {
    return failedReview(
      'learning_review_pr_batch',
      'Learning is disabled; PR retrospective is blocked.',
      ['learning-enabled'],
    );
  }

  const trigger = parsed.output.trigger ?? 'manual';
  const limit = Math.min(
    parsed.output.limit ?? config.maxPrBatchItems,
    config.maxPrBatchItems,
  );
  const handledEvents = listHandledPrEventsForReview(
    {
      repoId: parsed.output.repoId,
      limit,
      sinceLastReview: trigger !== 'manual',
    },
    paths,
  );
  if (handledEvents.length === 0) {
    return failedReview(
      'learning_review_pr_batch',
      'No handled PR/autopilot events are available for review.',
      ['pr_handled'],
    );
  }

  const memories = await listPrLearningMemories(
    handledEvents.map((event) => event.repoId),
    paths,
  );
  const workflowSummaries = listRelatedWorkflowSummaries(handledEvents, paths);
  const preparedDiffs = listRelatedPreparedDiffSummaries(handledEvents, paths);
  const verificationResults = listRelatedVerificationSummaries(
    handledEvents,
    paths,
  );
  const notifications = listRelatedNotificationSummaries(handledEvents, paths);
  const kiloResults = listRelatedKiloResultSummaries(handledEvents, paths);
  const automationHealth = await readAutomationHealth(paths);
  const skillSnippets = await readLearningSkillSnippets(paths, {
    handledEvents,
    workflowSummaries,
    preparedDiffs,
    verificationResults,
    notifications,
    kiloResults,
    automationHealth,
  });
  const models = readAgentModelSelectionSync(paths);
  const inputSummary = compactJson({
    kind: 'pr-batch',
    trigger,
    reason: parsed.output.reason ?? null,
    policy: {
      memoryWriteMode: config.memoryWriteMode,
      skillWriteMode: config.skillWriteMode,
      maxPrBatchItems: config.maxPrBatchItems,
      evidenceSource:
        'compact app-state summaries only; no raw diffs, transcripts, logs, or secrets',
    },
    handledEvents: handledEvents.map(summarizeHandledPrEvent),
    workflowSummaries,
    preparedDiffs,
    verificationResults,
    notifications,
    kiloResults,
    automationHealth,
    activeMemories: summarizeMemories(memories),
    skillSnippets,
  });
  const reviewId = options.reviewId ?? randomUUID();
  const prepared: PreparedLearningReview = {
    ok: true,
    reviewId,
    kind: 'pr-batch',
    mode: config.memoryWriteMode,
    skillMode: config.skillWriteMode,
    model: models.selfImprovement,
    thinkingLevel: models.selfImprovementThinkingLevel,
    inputSummary,
    prompt: learningPrompt('pr-batch', inputSummary, config.memoryWriteMode),
    allowedMemoryIds: memories.map((memory) => memory.id),
    memorySnapshots: learningMemorySnapshots(memories),
    allowedProjectRepoIds: uniqueRepoIds([
      null,
      ...handledEvents.map((event) => event.repoId),
      ...projectRepoIdsFromMemories(memories),
    ]),
    allowedSkillIds: skillSnippets.map((skill) => skill.id),
    skillSnapshots: learningSkillSnapshots(skillSnippets),
  };
  startLearningReview(
    {
      id: reviewId,
      kind: 'pr-batch',
      model: models.selfImprovement,
      thinkingLevel: models.selfImprovementThinkingLevel,
      trigger: {
        type: trigger,
        repoId: parsed.output.repoId ?? null,
        handledEventIds: handledEvents.map((event) => event.id),
      },
      inputSummary,
      prepared,
      agentId: `learning-review:${reviewId}`,
    },
    paths,
  );
  return prepared;
}

function learningMemorySnapshots(
  memories: Array<{
    id: string;
    scope: 'user' | 'local' | 'project';
    key: string;
    repoId: string | null;
    updatedAt: string;
  }>,
): PreparedLearningReview['memorySnapshots'] {
  return memories.map(({ id, scope, key, repoId, updatedAt }) => ({
    id,
    scope,
    key,
    repoId,
    updatedAt,
  }));
}

function learningSkillSnapshots(
  skills: Array<{ id: string; sha256: string }>,
): PreparedLearningReview['skillSnapshots'] {
  return skills.map(({ id, sha256 }) => ({ id, sha256 }));
}
