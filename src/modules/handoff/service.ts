import { createHash } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import type { JsonValue } from '@flue/runtime';
import { parseInput } from '../../lib/valibot';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { addNotification, addWorkflowSummary } from '../app-state';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import { addPrWatch, resolvePrReference } from '../watches';
import {
  handoffNoteInputSchema,
  handoffRegisterPrInputSchema,
  handoffWatchPrInputSchema,
  type HandoffActionResult,
} from './schemas';
import * as v from 'valibot';

export type HandoffDependencies = {
  addPrWatch?: typeof addPrWatch;
  createNotification?: typeof addNotification;
  invokeReviewPrWorkflow?: (input: {
    ref: string;
  }) => Promise<{ runId: string }>;
};

type ResolvedRepo = Awaited<
  ReturnType<typeof readRepoRegistrySnapshot>
>['repos'][number];

type PrLink = {
  repo: ResolvedRepo;
  ref: {
    id: string;
    repoId: string;
    repoFullName: string;
    githubOwner: string;
    githubName: string;
    prNumber: number;
  };
};

const deckUrl = '/';

export async function registerHandoffWatchPr(
  rawInput: v.InferInput<typeof handoffWatchPrInputSchema>,
  paths = runtimePaths(),
  dependencies: HandoffDependencies = {},
): Promise<HandoffActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseHandoffInput(
    handoffWatchPrInputSchema,
    rawInput,
    'handoff_pr_watch',
  );
  if (!parsed.ok) return parsed.result;

  const source = normalizeHandoffSource(parsed.input.source);
  const prLink = await resolveRegisteredPrLink(parsed.input.ref, paths);
  if (!prLink.ok) return prLink.result;

  const desiredTerminalState = parsed.input.desiredTerminalState ?? 'checks';
  const watchInput: Parameters<typeof addPrWatch>[0] = {
    ref: prLink.link.ref.id,
    desiredTerminalState,
    createdBy: source,
  };
  if (parsed.input.intervalSeconds !== undefined) {
    watchInput.intervalSeconds = parsed.input.intervalSeconds;
  }
  const watchResult = await (dependencies.addPrWatch ?? addPrWatch)(
    watchInput,
    paths,
  );
  if (!watchResult.ok) {
    return failResult('handoff_pr_watch', watchResult.message, {
      errors: watchResult.errors,
      requires: watchResult.requires,
    });
  }

  const watchId = watchIdFromValue(watchResult.watch);
  const audit = await addHandoffAudit(
    {
      event: 'watch-pr',
      source,
      ref: prLink.link.ref.id,
      desiredTerminalState,
      intervalSeconds: parsed.input.intervalSeconds ?? null,
      watchId: watchId ?? null,
    },
    paths,
  );

  return okResult(
    'handoff_pr_watch',
    watchResult.changed,
    watchResult.changed
      ? `Watching ${prLink.link.ref.id} from ${displaySource(source)}.`
      : `Watch for ${prLink.link.ref.id} was already current.`,
    {
      id: watchId,
      watch: watchResult.watch,
      audit,
    },
  );
}

export async function createHandoffNote(
  rawInput: v.InferInput<typeof handoffNoteInputSchema>,
  paths = runtimePaths(),
  dependencies: HandoffDependencies = {},
): Promise<HandoffActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseHandoffInput(
    handoffNoteInputSchema,
    rawInput,
    'handoff_note_create',
  );
  if (!parsed.ok) return parsed.result;

  const source = normalizeHandoffSource(parsed.input.source);
  const prLink = parsed.input.pr
    ? await resolveRegisteredPrLink(parsed.input.pr, paths)
    : null;
  if (prLink && !prLink.ok) return prLink.result;

  const repoResult = parsed.input.repo
    ? await resolveRegisteredRepo(parsed.input.repo, paths)
    : null;
  if (repoResult && !repoResult.ok) return repoResult.result;

  const repo = prLink?.link.repo ?? repoResult?.repo ?? null;
  if (prLink?.link.repo && repoResult?.repo) {
    const prRepo = repoFullName(prLink.link.repo).toLowerCase();
    const noteRepo = repoFullName(repoResult.repo).toLowerCase();
    if (prRepo !== noteRepo) {
      return failResult(
        'handoff_note_create',
        `Note repo "${repoFullName(repoResult.repo)}" does not match PR repo "${repoFullName(prLink.link.repo)}".`,
        { requires: ['repo'] },
      );
    }
  }

  const level =
    parsed.input.level === 'urgent' ? 'attention' : parsed.input.level;
  const sourceId = noteSourceId({
    source,
    text: parsed.input.text,
    repoFullName: repo ? repoFullName(repo) : null,
    prId: prLink?.link.ref.id ?? null,
  });
  const notification = await (
    dependencies.createNotification ?? addNotification
  )(
    {
      level,
      title: `Note from ${displaySource(source)}`,
      message: parsed.input.text,
      source,
      sourceId,
      data: {
        kind: 'external-note',
        source,
        repoId: repo?.id ?? null,
        repoFullName: repo ? repoFullName(repo) : null,
        prNumber: prLink?.link.ref.prNumber ?? null,
        prRef: prLink?.link.ref.id ?? null,
      },
    },
    paths,
  );

  const audit = await addHandoffAudit(
    {
      event: 'note',
      source,
      notificationId: notification.id,
      repoId: repo?.id ?? null,
      repoFullName: repo ? repoFullName(repo) : null,
      prRef: prLink?.link.ref.id ?? null,
      level,
    },
    paths,
  );

  return okResult('handoff_note_create', true, 'Created handoff note.', {
    id: notification.id,
    notification,
    audit,
  });
}

export async function registerHandoffPr(
  rawInput: v.InferInput<typeof handoffRegisterPrInputSchema>,
  paths = runtimePaths(),
  dependencies: HandoffDependencies = {},
): Promise<HandoffActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseHandoffInput(
    handoffRegisterPrInputSchema,
    rawInput,
    'handoff_pr_register',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const source = normalizeHandoffSource(input.source);
  if (input.review === true) {
    const allowed = await externalReviewQueueAllowed(paths);
    if (!allowed) {
      return failResult(
        'handoff_pr_register',
        'External PR review queueing is disabled by handoff.allowExternalReviewQueue.',
        { requires: ['handoff.allowExternalReviewQueue'] },
      );
    }
  }

  const prLink = await resolveRegisteredPrLink(input.ref, paths);
  if (!prLink.ok) return prLink.result;

  const ref = prLink.link.ref.id;
  const watchEnabled = input.watch ?? true;
  let watch: HandoffActionResult['watch'];
  let watchChanged = false;
  let watchId: string | undefined;
  if (watchEnabled) {
    const watchResult = await (dependencies.addPrWatch ?? addPrWatch)(
      {
        ref,
        desiredTerminalState: 'checks',
        createdBy: source,
      },
      paths,
    );
    if (!watchResult.ok) {
      return failResult('handoff_pr_register', watchResult.message, {
        errors: watchResult.errors,
        requires: watchResult.requires,
      });
    }
    watch = watchResult.watch;
    watchChanged = watchResult.changed;
    watchId = watchIdFromValue(watch);
  }

  let notification: HandoffActionResult['notification'];
  if (input.note) {
    const noteResult = await createHandoffNote(
      {
        text: input.note,
        source,
        pr: ref,
        level: 'ready',
      },
      paths,
      dependencies,
    );
    if (!noteResult.ok) return noteResult;
    notification = noteResult.notification;
  }

  let review: HandoffActionResult['review'];
  if (input.review === true) {
    const invokeReview =
      dependencies.invokeReviewPrWorkflow ?? invokeReviewPrWorkflow;
    try {
      const { runId } = await invokeReview({ ref });
      review = asJsonValue({
        workflow: 'review-pr-for-human',
        runId,
        ref,
        queued: true,
      });
    } catch (error) {
      const message = errorMessage(error);
      const audit = await addHandoffAudit(
        {
          event: 'register-pr',
          source,
          ref,
          watch: watchEnabled,
          watchId: watchId ?? null,
          note: Boolean(input.note),
          notificationId: notificationIdFromValue(notification) ?? null,
          review: true,
          error: message,
        },
        paths,
        { status: 'failed' },
      );
      return failResult(
        'handoff_pr_register',
        `Review agent admission failed for ${ref}.`,
        {
          changed: watchChanged || Boolean(notification),
          id: watchId ?? notificationIdFromValue(notification),
          watch,
          notification,
          audit,
          errors: [message],
          requires: ['reviewAgentAdmission'],
        },
      );
    }
  }

  const reviewRunId = reviewRunIdFromValue(review);
  const audit = await addHandoffAudit(
    {
      event: 'register-pr',
      source,
      ref,
      watch: watchEnabled,
      watchId: watchId ?? null,
      note: Boolean(input.note),
      notificationId: notificationIdFromValue(notification) ?? null,
      review: input.review === true,
      reviewRunId: reviewRunId ?? null,
    },
    paths,
    reviewRunId ? { runId: reviewRunId } : undefined,
  );

  const changed = watchChanged || Boolean(notification) || Boolean(review);
  return okResult(
    'handoff_pr_register',
    changed,
    changed
      ? `Registered ${ref} from ${displaySource(source)}.`
      : `Registration for ${ref} was already current.`,
    {
      id: watchId ?? notificationIdFromValue(notification),
      watch,
      notification,
      review,
      audit,
    },
  );
}

export function normalizeHandoffSource(
  value: string | undefined,
  fallback = 'external:cli',
) {
  const raw = (value?.trim() || fallback).replace(/\s+/g, '-');
  const normalized = /^(?:external|ci):/i.test(raw) ? raw : `external:${raw}`;
  return normalized.slice(0, 120);
}

function parseHandoffInput<TSchema extends v.GenericSchema<unknown, unknown>>(
  schema: TSchema,
  input: v.InferInput<TSchema>,
  action: string,
):
  | { ok: true; input: v.InferOutput<TSchema> }
  | {
      ok: false;
      result: HandoffActionResult;
    } {
  return parseInput(schema, input, (message) =>
    failResult(action, 'Invalid handoff input.', {
      errors: [message],
    }),
  );
}

async function resolveRegisteredPrLink(
  ref: string,
  paths: RuntimePaths,
): Promise<
  | { ok: true; link: PrLink }
  | {
      ok: false;
      result: HandoffActionResult;
    }
> {
  const registry = await readRepoRegistrySnapshot(paths);
  const resolved = resolvePrReference(ref, registry);
  if (!resolved.ok) {
    return {
      ok: false,
      result: failResult('handoff_pr_reference', resolved.result.message, {
        errors: resolved.result.errors,
        requires: resolved.result.requires,
      }),
    };
  }

  const repo = registry.repos.find(
    (item) =>
      repoFullName(item).toLowerCase() ===
        resolved.reference.repoFullName.toLowerCase() ||
      item.id === resolved.reference.repoId,
  );
  if (!repo) {
    return {
      ok: false,
      result: failResult(
        'handoff_pr_reference',
        `Repository "${resolved.reference.repoFullName}" is not configured.`,
        { requires: ['repo'] },
      ),
    };
  }

  return { ok: true, link: { repo, ref: resolved.reference } };
}

async function resolveRegisteredRepo(
  ref: string,
  paths: RuntimePaths,
): Promise<
  | { ok: true; repo: ResolvedRepo }
  | {
      ok: false;
      result: HandoffActionResult;
    }
> {
  const registry = await readRepoRegistrySnapshot(paths);
  const matches = registry.repos.filter(
    (repo) =>
      repo.id === ref ||
      repo.github.name === ref ||
      repoFullName(repo).toLowerCase() === ref.toLowerCase(),
  );
  if (matches.length === 1) return { ok: true, repo: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      result: failResult(
        'handoff_repo_reference',
        `Repository "${ref}" is ambiguous.`,
        { requires: ['repo'] },
      ),
    };
  }
  return {
    ok: false,
    result: failResult(
      'handoff_repo_reference',
      `Repository "${ref}" is not configured.`,
      { requires: ['repo'] },
    ),
  };
}

async function externalReviewQueueAllowed(paths: RuntimePaths) {
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return config.handoff?.allowExternalReviewQueue ?? true;
}

async function invokeReviewPrWorkflow(input: { ref: string }) {
  const { admitPrReviewAssist } = await import('../pr-review-assist');
  return admitPrReviewAssist(input);
}

async function addHandoffAudit(
  summary: Record<string, JsonValue>,
  paths: RuntimePaths,
  options: { status?: string; runId?: string } = {},
) {
  const input: Parameters<typeof addWorkflowSummary>[0] = {
    workflow: 'agent_handoff',
    status: options.status ?? 'completed',
    summary,
  };
  if (options.runId) input.runId = options.runId;
  return addWorkflowSummary(input, paths);
}

function okResult(
  action: string,
  changed: boolean,
  message: string,
  data: {
    id?: string;
    watch?: JsonValue;
    notification?: JsonValue;
    release?: JsonValue;
    review?: JsonValue;
    audit?: JsonValue;
  } = {},
): HandoffActionResult {
  const result: HandoffActionResult = {
    ok: true,
    action,
    changed,
    message,
    deckUrl,
  };
  if (data.id) result.id = data.id;
  if (data.watch) result.watch = asJsonValue(data.watch);
  if (data.notification) result.notification = asJsonValue(data.notification);
  if (data.release) result.release = asJsonValue(data.release);
  if (data.review) result.review = asJsonValue(data.review);
  if (data.audit) result.audit = asJsonValue(data.audit);
  return result;
}

function failResult(
  action: string,
  message: string,
  data: {
    changed?: boolean;
    id?: string;
    watch?: JsonValue;
    notification?: JsonValue;
    release?: JsonValue;
    review?: JsonValue;
    audit?: JsonValue;
    errors?: string[];
    requires?: string[];
  } = {},
): HandoffActionResult {
  const result: HandoffActionResult = {
    ok: false,
    action,
    changed: data.changed ?? false,
    message,
    deckUrl,
  };
  if (data.id) result.id = data.id;
  if (data.watch) result.watch = asJsonValue(data.watch);
  if (data.notification) result.notification = asJsonValue(data.notification);
  if (data.release) result.release = asJsonValue(data.release);
  if (data.review) result.review = asJsonValue(data.review);
  if (data.audit) result.audit = asJsonValue(data.audit);
  if (data.errors) result.errors = data.errors;
  if (data.requires) result.requires = data.requires;
  return result;
}

function displaySource(source: string) {
  return source.replace(/^(?:external|ci):/, '');
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function noteSourceId(input: {
  source: string;
  text: string;
  repoFullName: string | null;
  prId: string | null;
}) {
  return createHash('sha256')
    .update(
      [
        input.source,
        input.text,
        input.repoFullName ?? '',
        input.prId ?? '',
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 32);
}

const handoffIdSchema = v.looseObject({ id: v.optional(v.string()) });
const handoffRunIdSchema = v.looseObject({ runId: v.optional(v.string()) });

function watchIdFromValue(value: JsonValue | undefined) {
  const parsed = v.safeParse(handoffIdSchema, value);
  return parsed.success ? parsed.output.id : undefined;
}

function notificationIdFromValue(value: JsonValue | undefined) {
  const parsed = v.safeParse(handoffIdSchema, value);
  return parsed.success ? parsed.output.id : undefined;
}

function reviewRunIdFromValue(value: JsonValue | undefined) {
  const parsed = v.safeParse(handoffRunIdSchema, value);
  return parsed.success ? parsed.output.runId : undefined;
}
