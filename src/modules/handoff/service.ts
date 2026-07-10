import { createHash } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
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
import { addPrWatch, resolvePrReference, type PrWatch } from '../watches';
import {
  handoffNoteInputSchema,
  handoffRegisterPrInputSchema,
  handoffWatchPrInputSchema,
  type HandoffActionResult,
} from './schemas';
import type * as v from 'valibot';

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
  const watchResult = await (dependencies.addPrWatch ?? addPrWatch)(
    {
      ref: prLink.link.ref.id,
      desiredTerminalState,
      ...(parsed.input.intervalSeconds !== undefined
        ? { intervalSeconds: parsed.input.intervalSeconds }
        : {}),
      createdBy: source,
    },
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
          notificationId: notificationIdFromValue(notification),
          review: true,
          error: message,
        },
        paths,
        { status: 'failed' },
      );
      return failResult(
        'handoff_pr_register',
        `Review workflow dispatch failed for ${ref}.`,
        {
          changed: watchChanged || Boolean(notification),
          id: watchId ?? notificationIdFromValue(notification),
          watch,
          notification,
          audit,
          errors: [message],
          requires: ['workflowDispatch'],
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
      notificationId: notificationIdFromValue(notification),
      review: input.review === true,
      reviewRunId,
    },
    paths,
    reviewRunId ? { runId: reviewRunId } : {},
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

function parseHandoffInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
):
  | { ok: true; input: T }
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
  const { invoke } = await import('@flue/runtime');
  const workflow = await import('../../workflows/review-pr-for-human');
  return invoke(workflow.default, { input });
}

async function addHandoffAudit(
  summary: Record<string, unknown>,
  paths: RuntimePaths,
  options: { status?: string; runId?: string } = {},
) {
  return addWorkflowSummary(
    {
      workflow: 'agent_handoff',
      status: options.status ?? 'completed',
      ...(options.runId ? { runId: options.runId } : {}),
      summary,
    },
    paths,
  );
}

function okResult(
  action: string,
  changed: boolean,
  message: string,
  data: {
    id?: string;
    watch?: unknown;
    notification?: unknown;
    release?: unknown;
    review?: unknown;
    audit?: unknown;
  } = {},
): HandoffActionResult {
  return {
    ok: true,
    action,
    changed,
    message,
    ...(data.id ? { id: data.id } : {}),
    deckUrl,
    ...(data.watch ? { watch: asJsonValue(data.watch) } : {}),
    ...(data.notification
      ? { notification: asJsonValue(data.notification) }
      : {}),
    ...(data.release ? { release: asJsonValue(data.release) } : {}),
    ...(data.review ? { review: asJsonValue(data.review) } : {}),
    ...(data.audit ? { audit: asJsonValue(data.audit) } : {}),
  };
}

function failResult(
  action: string,
  message: string,
  data: {
    changed?: boolean;
    id?: string;
    watch?: unknown;
    notification?: unknown;
    release?: unknown;
    review?: unknown;
    audit?: unknown;
    errors?: string[];
    requires?: string[];
  } = {},
): HandoffActionResult {
  return {
    ok: false,
    action,
    changed: data.changed ?? false,
    message,
    ...(data.id ? { id: data.id } : {}),
    deckUrl,
    ...(data.watch ? { watch: asJsonValue(data.watch) } : {}),
    ...(data.notification
      ? { notification: asJsonValue(data.notification) }
      : {}),
    ...(data.release ? { release: asJsonValue(data.release) } : {}),
    ...(data.review ? { review: asJsonValue(data.review) } : {}),
    ...(data.audit ? { audit: asJsonValue(data.audit) } : {}),
    ...(data.errors ? { errors: data.errors } : {}),
    ...(data.requires ? { requires: data.requires } : {}),
  };
}

function displaySource(source: string) {
  return source.replace(/^(?:external|ci):/, '');
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
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

function watchIdFromValue(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as Partial<PrWatch>).id;
  return typeof id === 'string' ? id : undefined;
}

function notificationIdFromValue(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function reviewRunIdFromValue(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const runId = (value as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}
