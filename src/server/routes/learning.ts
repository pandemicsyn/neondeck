import { invoke } from '@flue/runtime';
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  decideMemoryCandidate,
  listMemoryCandidates,
} from '../../memory-actions';
import { listLearningReviews } from '../../learning-reviews';
import { readLearningOperatorState } from '../../learning-operator';
import type { RuntimePaths } from '../../runtime-home';
import {
  applySkillPatchCandidate,
  listSkillPatchCandidates,
  rejectSkillPatchCandidate,
} from '../../skill-patches';
import { readChatSession } from '../../session-actions';
import curateLearningStoreWorkflow from '../../workflows/curate_learning_store';
import reviewConversationForLearningWorkflow from '../../workflows/review_conversation_for_learning';
import reviewPrBatchForLearningWorkflow from '../../workflows/review_pr_batch_for_learning';
import { boundedQueryLimit, safeJsonBody } from '../http';

export function createLearningRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.post('/curate', async (c) => {
    const parsed = v.safeParse(
      v.object({
        mode: v.optional(v.picklist(['off', 'review', 'auto'])),
        reason: v.optional(v.string()),
      }),
      await safeJsonBody(c),
    );
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          action: 'learning_curate',
          changed: false,
          message: v.summarize(parsed.issues),
        },
        400,
      );
    }
    const receipt = await invoke(curateLearningStoreWorkflow, {
      input: { ...parsed.output, trigger: 'manual' },
    });
    return c.json({
      ok: true,
      action: 'learning_curate',
      changed: true,
      runId: receipt.runId,
      message: 'Queued memory curation learning workflow.',
    });
  });

  routes.get('/state', async (c) => {
    const input = {
      limit: boundedQueryLimit(c.req.query('limit'), 25),
      reviewKind: learningReviewKind(c.req.query('reviewKind')),
      reviewStatus: learningReviewStatus(c.req.query('reviewStatus')),
      candidateStatus: learningCandidateStatus(c.req.query('candidateStatus')),
      candidateTarget: learningCandidateTarget(c.req.query('candidateTarget')),
      memoryId: c.req.query('memoryId') || undefined,
    };
    if (c.req.query('limit') && input.limit === undefined) {
      return c.json(
        {
          ok: false,
          action: 'learning_operator_state',
          changed: false,
          message: `Invalid learning state limit "${c.req.query('limit')}".`,
        },
        400,
      );
    }
    if (c.req.query('reviewKind') && !input.reviewKind) {
      return c.json(
        {
          ok: false,
          action: 'learning_operator_state',
          changed: false,
          message: `Invalid review kind "${c.req.query('reviewKind')}".`,
        },
        400,
      );
    }
    if (c.req.query('reviewStatus') && !input.reviewStatus) {
      return c.json(
        {
          ok: false,
          action: 'learning_operator_state',
          changed: false,
          message: `Invalid review status "${c.req.query('reviewStatus')}".`,
        },
        400,
      );
    }
    if (c.req.query('candidateStatus') && !input.candidateStatus) {
      return c.json(
        {
          ok: false,
          action: 'learning_operator_state',
          changed: false,
          message: `Invalid candidate status "${c.req.query('candidateStatus')}".`,
        },
        400,
      );
    }
    if (c.req.query('candidateTarget') && !input.candidateTarget) {
      return c.json(
        {
          ok: false,
          action: 'learning_operator_state',
          changed: false,
          message: `Invalid candidate target "${c.req.query('candidateTarget')}".`,
        },
        400,
      );
    }
    const result = await readLearningOperatorState(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/reviews', (c) => {
    const kind = learningReviewKind(c.req.query('kind'));
    const status = learningReviewStatus(c.req.query('status'));
    const limit = boundedQueryLimit(c.req.query('limit'), 50);
    if (c.req.query('kind') && !kind) {
      return c.json(
        {
          ok: false,
          action: 'learning_review_list',
          changed: false,
          message: `Invalid learning review kind "${c.req.query('kind')}".`,
        },
        400,
      );
    }
    if (c.req.query('status') && !status) {
      return c.json(
        {
          ok: false,
          action: 'learning_review_list',
          changed: false,
          message: `Invalid learning review status "${c.req.query('status')}".`,
        },
        400,
      );
    }
    if (c.req.query('limit') && limit === undefined) {
      return c.json(
        {
          ok: false,
          action: 'learning_review_list',
          changed: false,
          message: `Invalid review limit "${c.req.query('limit')}".`,
        },
        400,
      );
    }
    return c.json(
      listLearningReviews(
        {
          kind,
          status,
          limit,
        },
        paths,
      ),
    );
  });

  routes.post('/reviews/conversation', async (c) => {
    const parsed = v.safeParse(
      v.object({
        sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
        reason: v.optional(v.string()),
      }),
      await safeJsonBody(c),
    );
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          action: 'learning_review_conversation',
          changed: false,
          message: v.summarize(parsed.issues),
        },
        400,
      );
    }
    if (parsed.output.sessionId) {
      const session = await readChatSession(
        {
          id: parsed.output.sessionId,
          reason: 'manual-conversation-learning-review',
          surface: 'learning',
        },
        paths,
      );
      if (!session.ok) return c.json(session, 400);
    }
    const receipt = await invoke(reviewConversationForLearningWorkflow, {
      input: { ...parsed.output, trigger: 'manual' },
    });
    return c.json({
      ok: true,
      action: 'learning_review_conversation',
      changed: true,
      runId: receipt.runId,
      message: 'Queued conversation learning review workflow.',
    });
  });

  routes.post('/reviews/prs', async (c) => {
    const parsed = v.safeParse(
      v.object({
        repoId: v.optional(v.pipe(v.string(), v.minLength(1))),
        reason: v.optional(v.string()),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      await safeJsonBody(c),
    );
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          action: 'learning_review_pr_batch',
          changed: false,
          message: v.summarize(parsed.issues),
        },
        400,
      );
    }
    const receipt = await invoke(reviewPrBatchForLearningWorkflow, {
      input: { ...parsed.output, trigger: 'manual' },
    });
    return c.json({
      ok: true,
      action: 'learning_review_pr_batch',
      changed: true,
      runId: receipt.runId,
      message: 'Queued PR/autopilot learning retrospective workflow.',
    });
  });

  routes.get('/candidates', async (c) => {
    const status = learningCandidateStatus(c.req.query('status'));
    if (c.req.query('status') && !status) {
      return c.json(
        {
          ok: false,
          action: 'memory_candidate_list',
          changed: false,
          message: `Invalid candidate status "${c.req.query('status')}".`,
        },
        400,
      );
    }
    const limit = Number(c.req.query('limit') ?? '100');
    if (c.req.query('limit') && !boundedQueryLimit(c.req.query('limit'), 100)) {
      return c.json(
        {
          ok: false,
          action: 'learning_candidate_list',
          changed: false,
          message: `Invalid candidate limit "${c.req.query('limit')}".`,
        },
        400,
      );
    }
    const boundedLimit = Number.isFinite(limit) ? limit : undefined;
    const [memoryCandidates, skillCandidates] = await Promise.all([
      listMemoryCandidates({ status, limit: boundedLimit }, paths),
      listSkillPatchCandidates({ status, limit: boundedLimit }, paths),
    ]);
    return c.json({
      ok: memoryCandidates.ok && skillCandidates.ok,
      action: 'learning_candidate_list',
      changed: false,
      candidates: [
        ...(memoryCandidates.candidates ?? []),
        ...(skillCandidates.candidates ?? []),
      ],
      memoryCandidates: memoryCandidates.candidates ?? [],
      skillCandidates: skillCandidates.candidates ?? [],
      fetchedAt: new Date().toISOString(),
    });
  });

  routes.post('/candidates/:id/approve', async (c) => {
    const body = (await safeJsonBody(c)) as Record<string, unknown>;
    const result = await decideMemoryCandidate(
      {
        ...body,
        id: c.req.param('id'),
        decision: 'apply',
      },
      paths,
    );
    if (result.ok) return c.json(result);
    if (!memoryCandidateWasNotFound(result)) return c.json(result, 400);
    const skillResult = await applySkillPatchCandidate(
      { ...body, id: c.req.param('id') },
      paths,
    );
    return c.json(skillResult, skillResult.ok ? 200 : 400);
  });

  routes.post('/candidates/:id/reject', async (c) => {
    const body = (await safeJsonBody(c)) as Record<string, unknown>;
    const result = await decideMemoryCandidate(
      {
        ...body,
        id: c.req.param('id'),
        decision: 'reject',
      },
      paths,
    );
    if (result.ok) return c.json(result);
    if (!memoryCandidateWasNotFound(result)) return c.json(result, 400);
    const skillResult = await rejectSkillPatchCandidate(
      { ...body, id: c.req.param('id') },
      paths,
    );
    return c.json(skillResult, skillResult.ok ? 200 : 400);
  });

  return routes;
}

export function learningCandidateStatus(
  value: string | undefined,
): 'proposed' | 'applied' | 'rejected' | 'archived' | undefined {
  if (
    value === 'proposed' ||
    value === 'applied' ||
    value === 'rejected' ||
    value === 'archived'
  ) {
    return value;
  }

  return undefined;
}

function learningCandidateTarget(
  value: string | undefined,
): 'memory' | 'skill' | undefined {
  if (value === 'memory' || value === 'skill') return value;
  return undefined;
}

function learningReviewKind(
  value: string | undefined,
): 'conversation' | 'curation' | 'pr-batch' | undefined {
  if (
    value === 'conversation' ||
    value === 'curation' ||
    value === 'pr-batch'
  ) {
    return value;
  }
  return undefined;
}

function learningReviewStatus(
  value: string | undefined,
): 'running' | 'completed' | 'failed' | undefined {
  if (value === 'running' || value === 'completed' || value === 'failed') {
    return value;
  }
  return undefined;
}

function memoryCandidateWasNotFound(result: unknown) {
  if (!result || typeof result !== 'object') return false;
  const record = result as { message?: unknown; requires?: unknown };
  return (
    record.message === 'Memory candidate was not found.' &&
    Array.isArray(record.requires) &&
    record.requires.includes('id')
  );
}
