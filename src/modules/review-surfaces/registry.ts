import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import {
  neonReviewFindingLimits,
  type NeonReviewFinding,
  type NeonReviewFindingDraft,
  type NeonReviewFindingPromotion,
  type ReviewSurfaceFindingChange,
  type ReviewSurfaceFindingPromoteRequest,
  type ReviewSurfaceFindingsClearRequest,
  type ReviewSurfaceFindingsDismissRequest,
} from '../../../shared/review-finding';
import { reviewRevisionKey } from '../../../shared/review-source';
import type { ReviewSourcePromotionTarget } from '../../../shared/review-source';
import type {
  ActiveReviewSurface,
  ReviewSurfaceChangeEvent,
  ReviewSurfaceNavigationAck,
  ReviewSurfaceNavigationAckStatus,
  ReviewSurfaceNavigationCommand,
  ReviewSurfaceNavigationRequest,
  ReviewSurfaceSnapshot,
} from '../../../shared/review-surface';
import { neonReviewFindingDraftSchema } from './schemas';

export const reviewSurfaceTtlMs = 45_000;

type ReviewSurfaceListener = (event: ReviewSurfaceChangeEvent) => void;

type ReviewSurfaceRegistryOptions = {
  now?: () => number;
  ttlMs?: number;
};

type TrustedReviewSurfaceFindingsApplyRequest = {
  revisionKey: string;
  findings: NeonReviewFindingDraft[];
};

export type ReviewSurfaceFindingErrorCode =
  | 'surface-not-active'
  | 'revision-unavailable'
  | 'stale-revision'
  | 'source-mismatch'
  | 'file-unavailable'
  | 'invalid-finding'
  | 'invalid-batch-size'
  | 'duplicate-finding-id'
  | 'finding-id-conflict'
  | 'surface-finding-limit'
  | 'finding-unavailable'
  | 'lifecycle-not-active'
  | 'already-promoted'
  | 'capability-mismatch'
  | 'unsupported-source'
  | 'promotion-target-unavailable'
  | 'anchor-unavailable'
  | 'confirmation-required'
  | 'promotion-pending'
  | 'promotion-request-conflict'
  | 'promotion-target-failed'
  | 'promotion-state-changed';

export type ReviewSurfaceFindingResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  surfaceId: string;
  revisionKey?: string | null;
  findings?: NeonReviewFinding[];
  findingIds?: string[];
  count?: number;
  error?: {
    code: ReviewSurfaceFindingErrorCode;
    message: string;
  };
};

export type ValidatedReviewSurfaceFindingPromotion = {
  surface: ActiveReviewSurface;
  finding: NeonReviewFinding;
  target: ReviewSourcePromotionTarget;
  request: ReviewSurfaceFindingPromoteRequest;
};

export class ReviewSurfaceRegistry {
  private readonly findings = new Map<string, Map<string, NeonReviewFinding>>();
  private readonly listeners = new Set<ReviewSurfaceListener>();
  private readonly pendingNavigations = new Map<string, string>();
  private readonly records = new Map<string, ActiveReviewSurface>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private expirationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ReviewSurfaceRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? reviewSurfaceTtlMs;
  }

  upsert(snapshot: ReviewSurfaceSnapshot) {
    this.pruneExpired();
    const existing = this.records.get(snapshot.surfaceId);
    const now = this.timestamp();
    const surface: ActiveReviewSurface = {
      ...snapshot,
      registeredAt: existing?.registeredAt ?? now,
      updatedAt: now,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      lastNavigationAck: existing?.lastNavigationAck ?? null,
    };
    this.records.set(surface.surfaceId, surface);
    this.publish({
      action: existing ? 'updated' : 'registered',
      surfaceId: surface.surfaceId,
    });
    const previousRevisionKey = existing
      ? reviewRevisionKey(existing.source.revision)
      : null;
    const nextRevisionKey = reviewRevisionKey(surface.source.revision);
    if (
      existing &&
      (existing.source.id !== surface.source.id ||
        previousRevisionKey !== nextRevisionKey)
    ) {
      this.staleActiveFindings(
        surface.surfaceId,
        nextRevisionKey,
        'The review surface source or revision changed.',
      );
    }
    this.scheduleExpiration();
    return surface;
  }

  list() {
    this.pruneExpired();
    return [...this.records.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  read(surfaceId: string) {
    this.pruneExpired();
    return this.records.get(surfaceId) ?? null;
  }

  readFindings(surfaceId: string): ReviewSurfaceFindingResult {
    const surface = this.read(surfaceId);
    if (!surface)
      return this.findingError(surfaceId, 'read', 'surface-not-active');
    const findings = [...(this.findings.get(surfaceId)?.values() ?? [])].sort(
      (left, right) =>
        left.provenance.createdAt.localeCompare(right.provenance.createdAt) ||
        left.id.localeCompare(right.id),
    );
    return {
      ok: true,
      action: 'read',
      changed: false,
      message: `Read ${findings.length} ephemeral review finding(s).`,
      surfaceId,
      revisionKey: reviewRevisionKey(surface.source.revision),
      findings,
      count: findings.length,
    };
  }

  applyFindings(
    surfaceId: string,
    input: TrustedReviewSurfaceFindingsApplyRequest,
  ): ReviewSurfaceFindingResult {
    const surface = this.read(surfaceId);
    if (!surface)
      return this.findingError(surfaceId, 'apply', 'surface-not-active');
    const currentRevisionKey = reviewRevisionKey(surface.source.revision);
    if (!currentRevisionKey) {
      return this.findingError(surfaceId, 'apply', 'revision-unavailable');
    }
    if (input.revisionKey !== currentRevisionKey) {
      return this.findingError(surfaceId, 'apply', 'stale-revision', {
        revisionKey: currentRevisionKey,
      });
    }
    if (
      input.findings.length === 0 ||
      input.findings.length > neonReviewFindingLimits.maxApplyBatch
    ) {
      return this.findingError(surfaceId, 'apply', 'invalid-batch-size', {
        revisionKey: currentRevisionKey,
      });
    }

    const parsedFindings: NeonReviewFindingDraft[] = [];
    for (const finding of input.findings) {
      const parsed = v.safeParse(neonReviewFindingDraftSchema, finding);
      if (!parsed.success) {
        return this.findingError(surfaceId, 'apply', 'invalid-finding', {
          revisionKey: currentRevisionKey,
        });
      }
      parsedFindings.push(parsed.output);
    }

    const ids = parsedFindings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      return this.findingError(surfaceId, 'apply', 'duplicate-finding-id', {
        revisionKey: currentRevisionKey,
      });
    }

    const sourcePaths = new Set(surface.source.files.map((file) => file.path));
    for (const finding of parsedFindings) {
      if (
        finding.sourceId !== surface.source.id ||
        finding.revisionKey !== currentRevisionKey
      ) {
        return this.findingError(surfaceId, 'apply', 'source-mismatch', {
          revisionKey: currentRevisionKey,
        });
      }
      if (!sourcePaths.has(finding.file)) {
        return this.findingError(surfaceId, 'apply', 'file-unavailable', {
          revisionKey: currentRevisionKey,
        });
      }
    }

    const existing = this.findings.get(surfaceId) ?? new Map();
    const findingsToApply: NeonReviewFindingDraft[] = [];
    let addedFindingCount = 0;
    for (const finding of parsedFindings) {
      const current = existing.get(finding.id);
      if (!current) {
        findingsToApply.push(finding);
        addedFindingCount += 1;
        continue;
      }
      if (sameFindingScope(current, finding)) {
        if (sameFindingDraft(current, finding)) continue;
        return this.findingError(surfaceId, 'apply', 'finding-id-conflict', {
          revisionKey: currentRevisionKey,
        });
      }
      if (current.lifecycle.state === 'active') {
        return this.findingError(surfaceId, 'apply', 'finding-id-conflict', {
          revisionKey: currentRevisionKey,
        });
      }
      findingsToApply.push(finding);
    }

    if (
      existing.size + addedFindingCount >
      neonReviewFindingLimits.maxFindingsPerSurface
    ) {
      return this.findingError(surfaceId, 'apply', 'surface-finding-limit', {
        revisionKey: currentRevisionKey,
      });
    }

    if (findingsToApply.length === 0) {
      return {
        ok: true,
        action: 'apply',
        changed: false,
        message: 'All finding ids were already applied with identical content.',
        surfaceId,
        revisionKey: currentRevisionKey,
        findings: parsedFindings.map((finding) => existing.get(finding.id)!),
        findingIds: [],
        count: 0,
      };
    }

    const changedAt = this.timestamp();
    const applied = findingsToApply.map((finding) =>
      materializeFinding(surfaceId, finding, changedAt),
    );
    const next = new Map(existing);
    for (const finding of applied) next.set(finding.id, finding);
    this.findings.set(surfaceId, next);
    this.publishFindingChange(surfaceId, {
      action: 'applied',
      revisionKey: currentRevisionKey,
      findingIds: applied.map((finding) => finding.id),
      count: applied.length,
    });
    return {
      ok: true,
      action: 'apply',
      changed: true,
      message: `Applied ${applied.length} ephemeral review finding(s).`,
      surfaceId,
      revisionKey: currentRevisionKey,
      findings: parsedFindings.map((finding) => next.get(finding.id)!),
      findingIds: applied.map((finding) => finding.id),
      count: applied.length,
    };
  }

  dismissFindings(
    surfaceId: string,
    input: ReviewSurfaceFindingsDismissRequest,
  ): ReviewSurfaceFindingResult {
    const surface = this.read(surfaceId);
    if (!surface)
      return this.findingError(surfaceId, 'dismiss', 'surface-not-active');
    const scopeError = this.findingMutationScopeError(
      surface,
      'dismiss',
      input.sourceId,
      input.revisionKey,
    );
    if (scopeError) return scopeError;
    if (
      input.findingIds.length === 0 ||
      input.findingIds.length > neonReviewFindingLimits.maxApplyBatch
    ) {
      return this.findingError(surfaceId, 'dismiss', 'invalid-batch-size');
    }
    if (new Set(input.findingIds).size !== input.findingIds.length) {
      return this.findingError(surfaceId, 'dismiss', 'duplicate-finding-id');
    }
    const current = this.findings.get(surfaceId);
    const changedAt = this.timestamp();
    const changedIds: string[] = [];
    const next = new Map(current);
    for (const findingId of input.findingIds) {
      const finding = next.get(findingId);
      if (!finding || finding.lifecycle.state === 'dismissed') continue;
      if (
        finding.lifecycle.state !== 'active' &&
        finding.lifecycle.state !== 'stale'
      ) {
        continue;
      }
      next.set(findingId, {
        ...finding,
        lifecycle: {
          state: 'dismissed',
          changedAt,
          reason: input.reason,
          promotion: finding.lifecycle.promotion,
        },
      });
      changedIds.push(findingId);
    }
    if (changedIds.length > 0) {
      this.findings.set(surfaceId, next);
      this.publishFindingChange(surfaceId, {
        action: 'dismissed',
        revisionKey: reviewRevisionKey(surface.source.revision),
        findingIds: changedIds,
        count: changedIds.length,
      });
    }
    return {
      ok: true,
      action: 'dismiss',
      changed: changedIds.length > 0,
      message: `Dismissed ${changedIds.length} ephemeral review finding(s).`,
      surfaceId,
      revisionKey: reviewRevisionKey(surface.source.revision),
      findingIds: changedIds,
      count: changedIds.length,
    };
  }

  clearFindings(
    surfaceId: string,
    input: ReviewSurfaceFindingsClearRequest,
  ): ReviewSurfaceFindingResult {
    const surface = this.read(surfaceId);
    if (!surface)
      return this.findingError(surfaceId, 'clear', 'surface-not-active');
    const scopeError = this.findingMutationScopeError(
      surface,
      'clear',
      input.sourceId,
      input.revisionKey,
    );
    if (scopeError) return scopeError;
    if (
      input.findingIds &&
      (input.findingIds.length === 0 ||
        input.findingIds.length > neonReviewFindingLimits.maxApplyBatch)
    ) {
      return this.findingError(surfaceId, 'clear', 'invalid-batch-size');
    }
    if (
      input.findingIds &&
      new Set(input.findingIds).size !== input.findingIds.length
    ) {
      return this.findingError(surfaceId, 'clear', 'duplicate-finding-id');
    }
    const current = this.findings.get(surfaceId);
    const requestedIds = input.findingIds ?? [...(current?.keys() ?? [])];
    const clearedIds = requestedIds.filter((findingId) =>
      current?.has(findingId),
    );
    if (clearedIds.length > 0 && current) {
      const next = new Map(current);
      for (const findingId of clearedIds) next.delete(findingId);
      if (next.size > 0) this.findings.set(surfaceId, next);
      else this.findings.delete(surfaceId);
      this.publishFindingChange(surfaceId, {
        action: 'cleared',
        revisionKey: reviewRevisionKey(surface.source.revision),
        findingIds: clearedIds,
        count: clearedIds.length,
      });
    }
    return {
      ok: true,
      action: 'clear',
      changed: clearedIds.length > 0,
      message: `Cleared ${clearedIds.length} ephemeral review finding(s).`,
      surfaceId,
      revisionKey: reviewRevisionKey(surface.source.revision),
      findingIds: clearedIds,
      count: clearedIds.length,
    };
  }

  validateFindingPromotion(
    surfaceId: string,
    input: ReviewSurfaceFindingPromoteRequest,
  ):
    | { ok: true; value: ValidatedReviewSurfaceFindingPromotion }
    | { ok: false; result: ReviewSurfaceFindingResult } {
    const surface = this.read(surfaceId);
    if (!surface) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'surface-not-active'),
      };
    }
    const scopeError = this.findingMutationScopeError(
      surface,
      'promote',
      input.sourceId,
      input.revisionKey,
    );
    if (scopeError) return { ok: false, result: scopeError };
    const finding = this.findings.get(surfaceId)?.get(input.findingId);
    if (!finding) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'finding-unavailable', {
          revisionKey: reviewRevisionKey(surface.source.revision),
        }),
      };
    }
    if (
      finding.sourceId !== input.sourceId ||
      finding.revisionKey !== input.revisionKey
    ) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'source-mismatch', {
          revisionKey: reviewRevisionKey(surface.source.revision),
        }),
      };
    }
    if (finding.lifecycle.state === 'promoted') {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'already-promoted', {
          revisionKey: reviewRevisionKey(surface.source.revision),
        }),
      };
    }
    if (finding.lifecycle.state !== 'active') {
      return {
        ok: false,
        result: this.findingError(
          surfaceId,
          'promote',
          'lifecycle-not-active',
          { revisionKey: reviewRevisionKey(surface.source.revision) },
        ),
      };
    }
    const supportedSource =
      input.destination === 'github-review-draft'
        ? surface.source.kind === 'github-pr'
        : surface.source.kind === 'prepared-diff' ||
          surface.source.kind === 'kilo-result';
    if (!supportedSource) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'unsupported-source'),
      };
    }
    const expectedCapability =
      input.destination === 'github-review-draft'
        ? 'comments'
        : 'request-revision';
    if (!surface.source.capabilities.includes(expectedCapability)) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'capability-mismatch'),
      };
    }
    const target = surface.source.promotionTargets.find(
      (candidate) => candidate.destination === input.destination,
    );
    if (!target) {
      return {
        ok: false,
        result: this.findingError(
          surfaceId,
          'promote',
          'promotion-target-unavailable',
        ),
      };
    }
    const file = surface.source.files.find(
      (candidate) => candidate.path === finding.file,
    );
    if (
      !file ||
      file.patchState === 'unavailable' ||
      file.patchState === 'truncated' ||
      file.patchState === 'binary' ||
      file.patchState === 'stale'
    ) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'anchor-unavailable'),
      };
    }
    if (
      input.anchor.side !== finding.anchor.side ||
      (finding.anchor.kind === 'line-range' &&
        (input.anchor.startLine !== finding.anchor.startLine ||
          input.anchor.endLine !== finding.anchor.endLine)) ||
      (finding.anchor.kind === 'hunk' &&
        input.anchor.startLine !== input.anchor.endLine)
    ) {
      return {
        ok: false,
        result: this.findingError(surfaceId, 'promote', 'anchor-unavailable'),
      };
    }
    if (
      input.destination === 'prepared-diff-revision' &&
      input.confirm !== true
    ) {
      return {
        ok: false,
        result: this.findingError(
          surfaceId,
          'promote',
          'confirmation-required',
        ),
      };
    }
    return { ok: true, value: { surface, finding, target, request: input } };
  }

  completeFindingPromotion(
    surfaceId: string,
    input: ReviewSurfaceFindingPromoteRequest,
    promotion: NeonReviewFindingPromotion,
  ): ReviewSurfaceFindingResult {
    const validated = this.validateFindingPromotion(surfaceId, input);
    if (!validated.ok) {
      const current = this.read(surfaceId);
      return this.findingError(
        surfaceId,
        'promote',
        'promotion-state-changed',
        {
          revisionKey: current
            ? reviewRevisionKey(current.source.revision)
            : null,
        },
      );
    }
    const changedAt = this.timestamp();
    const finding = {
      ...validated.value.finding,
      lifecycle: {
        state: 'promoted' as const,
        changedAt,
        reason:
          promotion.destination === 'github-review-draft'
            ? 'Promoted to a local GitHub review draft; submission remains separate.'
            : 'Promoted to a prepared-diff revision request; execution remains separate.',
        promotion,
      },
    };
    const next = new Map(this.findings.get(surfaceId));
    next.set(finding.id, finding);
    this.findings.set(surfaceId, next);
    this.publishFindingChange(surfaceId, {
      action: 'promoted',
      revisionKey: input.revisionKey,
      findingIds: [finding.id],
      count: 1,
    });
    return {
      ok: true,
      action: 'promote',
      changed: true,
      message: finding.lifecycle.reason,
      surfaceId,
      revisionKey: input.revisionKey,
      findings: [finding],
      findingIds: [finding.id],
      count: 1,
    };
  }

  heartbeat(surfaceId: string) {
    const current = this.read(surfaceId);
    if (!current) return null;
    const surface = {
      ...current,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    };
    this.records.set(surfaceId, surface);
    this.scheduleExpiration();
    return surface;
  }

  remove(surfaceId: string, reason: 'closed' | 'expired' = 'closed') {
    const surface = this.records.get(surfaceId);
    if (!surface) return false;
    this.records.delete(surfaceId);
    this.findings.delete(surfaceId);
    for (const [commandId, targetSurfaceId] of this.pendingNavigations) {
      if (targetSurfaceId === surfaceId)
        this.pendingNavigations.delete(commandId);
    }
    this.publish({ action: 'removed', surfaceId, reason });
    this.scheduleExpiration();
    return true;
  }

  navigate(surfaceId: string, request: ReviewSurfaceNavigationRequest) {
    const surface = this.read(surfaceId);
    if (!surface) return null;
    const navigation: ReviewSurfaceNavigationCommand = {
      ...request,
      commandId: randomUUID(),
      surfaceId,
      revisionKey:
        request.revisionKey ?? reviewRevisionKey(surface.source.revision),
      requestedAt: this.timestamp(),
    };
    this.pendingNavigations.set(navigation.commandId, surfaceId);
    this.publish({
      action: 'navigation',
      surfaceId,
      navigation,
    });
    return navigation;
  }

  acknowledge(
    surfaceId: string,
    commandId: string,
    input: {
      status: ReviewSurfaceNavigationAckStatus;
      revisionKey: string | null;
      resolvedPath: string | null;
      message: string | null;
    },
  ) {
    const current = this.read(surfaceId);
    if (!current || this.pendingNavigations.get(commandId) !== surfaceId) {
      return null;
    }
    this.pendingNavigations.delete(commandId);
    const acknowledgedAt = this.timestamp();
    const acknowledgement: ReviewSurfaceNavigationAck = {
      ...input,
      commandId,
      surfaceId,
      acknowledgedAt,
    };
    const surface: ActiveReviewSurface = {
      ...current,
      updatedAt: acknowledgedAt,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      lastNavigationAck: acknowledgement,
    };
    this.records.set(surfaceId, surface);
    this.publish({
      action: 'acknowledged',
      surfaceId,
      acknowledgement,
    });
    this.scheduleExpiration();
    return acknowledgement;
  }

  subscribe(listener: ReviewSurfaceListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose() {
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    this.listeners.clear();
    this.pendingNavigations.clear();
    this.records.clear();
    this.findings.clear();
  }

  private pruneExpired() {
    const now = this.now();
    const expired = [...this.records.values()].filter(
      (surface) => Date.parse(surface.expiresAt) <= now,
    );
    for (const surface of expired) this.remove(surface.surfaceId, 'expired');
  }

  private scheduleExpiration() {
    if (this.expirationTimer) clearTimeout(this.expirationTimer);
    this.expirationTimer = null;
    const nextExpiration = Math.min(
      ...[...this.records.values()].map((surface) =>
        Date.parse(surface.expiresAt),
      ),
    );
    if (!Number.isFinite(nextExpiration)) return;
    this.expirationTimer = setTimeout(
      () => {
        this.expirationTimer = null;
        this.pruneExpired();
        this.scheduleExpiration();
      },
      Math.max(0, nextExpiration - this.now()),
    );
    this.expirationTimer.unref?.();
  }

  private publish(
    input: Pick<ReviewSurfaceChangeEvent, 'action' | 'surfaceId'> &
      Partial<
        Pick<
          ReviewSurfaceChangeEvent,
          'surface' | 'navigation' | 'acknowledgement' | 'reason' | 'findings'
        >
      >,
  ) {
    const event: ReviewSurfaceChangeEvent = {
      id: randomUUID(),
      action: input.action,
      surfaceId: input.surfaceId,
      changedAt: this.timestamp(),
      surface: input.surface ?? null,
      navigation: input.navigation ?? null,
      acknowledgement: input.acknowledgement ?? null,
      findings: input.findings ?? null,
      reason: input.reason ?? null,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.listeners.delete(listener);
        console.error('[neondeck] review surface event listener failed', error);
      }
    }
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }

  private staleActiveFindings(
    surfaceId: string,
    revisionKey: string | null,
    reason: string,
  ) {
    const current = this.findings.get(surfaceId);
    if (!current) return;
    const changedAt = this.timestamp();
    const changedIds: string[] = [];
    const next = new Map(current);
    for (const [findingId, finding] of current) {
      if (finding.lifecycle.state !== 'active') continue;
      next.set(findingId, {
        ...finding,
        lifecycle: {
          state: 'stale',
          changedAt,
          reason,
          promotion: finding.lifecycle.promotion,
        },
      });
      changedIds.push(findingId);
    }
    if (changedIds.length === 0) return;
    this.findings.set(surfaceId, next);
    this.publishFindingChange(surfaceId, {
      action: 'staled',
      revisionKey,
      findingIds: changedIds,
      count: changedIds.length,
    });
  }

  private publishFindingChange(
    surfaceId: string,
    change: ReviewSurfaceFindingChange,
  ) {
    this.publish({
      action: 'findings-changed',
      surfaceId,
      findings: {
        ...change,
        findingIds: change.findingIds.slice(
          0,
          neonReviewFindingLimits.maxEventFindingIds,
        ),
      },
    });
  }

  private findingError(
    surfaceId: string,
    action: string,
    code: ReviewSurfaceFindingErrorCode,
    extra: Pick<ReviewSurfaceFindingResult, 'revisionKey'> = {},
  ): ReviewSurfaceFindingResult {
    const message = findingErrorMessage(code);
    return {
      ok: false,
      action,
      changed: false,
      message,
      surfaceId,
      ...extra,
      error: { code, message },
    };
  }

  private findingMutationScopeError(
    surface: ActiveReviewSurface,
    action: string,
    sourceId: string,
    revisionKey: string,
  ) {
    const currentRevisionKey = reviewRevisionKey(surface.source.revision);
    if (sourceId !== surface.source.id) {
      return this.findingError(surface.surfaceId, action, 'source-mismatch', {
        revisionKey: currentRevisionKey,
      });
    }
    if (revisionKey !== currentRevisionKey) {
      return this.findingError(surface.surfaceId, action, 'stale-revision', {
        revisionKey: currentRevisionKey,
      });
    }
    return null;
  }
}

function materializeFinding(
  surfaceId: string,
  finding: NeonReviewFindingDraft,
  createdAt: string,
): NeonReviewFinding {
  return {
    ...finding,
    surfaceId,
    provenance: { ...finding.provenance, createdAt },
    lifecycle: {
      state: 'active',
      changedAt: createdAt,
      reason: null,
      promotion: null,
    },
  };
}

function sameFindingDraft(
  finding: NeonReviewFinding,
  draft: NeonReviewFindingDraft,
) {
  return (
    JSON.stringify({
      schemaVersion: finding.schemaVersion,
      id: finding.id,
      sourceId: finding.sourceId,
      revisionKey: finding.revisionKey,
      file: finding.file,
      anchor: finding.anchor,
      title: finding.title,
      explanation: finding.explanation,
      severity: finding.severity,
      confidence: finding.confidence,
      suggestedAction: finding.suggestedAction,
      provenance: {
        authorRole: finding.provenance.authorRole,
        model: finding.provenance.model,
        workflowRunId: finding.provenance.workflowRunId,
      },
    }) === JSON.stringify(draft)
  );
}

function sameFindingScope(
  finding: NeonReviewFinding,
  draft: NeonReviewFindingDraft,
) {
  return (
    finding.sourceId === draft.sourceId &&
    finding.revisionKey === draft.revisionKey
  );
}

function findingErrorMessage(code: ReviewSurfaceFindingErrorCode) {
  switch (code) {
    case 'surface-not-active':
      return 'Review surface is not active.';
    case 'revision-unavailable':
      return 'Review surface has no resolved revision for anchored findings.';
    case 'stale-revision':
      return 'Finding batch revision does not match the active review surface.';
    case 'source-mismatch':
      return 'Every finding must match the active source and revision.';
    case 'file-unavailable':
      return 'Every finding must anchor to a file in the active review surface.';
    case 'invalid-finding':
      return 'Every finding must satisfy the complete anchor, content, and provenance schema.';
    case 'invalid-batch-size':
      return `Finding batches must contain between 1 and ${neonReviewFindingLimits.maxApplyBatch} items.`;
    case 'duplicate-finding-id':
      return 'Finding ids must be unique within a batch.';
    case 'finding-id-conflict':
      return 'A finding id is already associated with different content.';
    case 'surface-finding-limit':
      return `A review surface may retain at most ${neonReviewFindingLimits.maxFindingsPerSurface} ephemeral findings.`;
    case 'finding-unavailable':
      return 'The requested finding is not retained on this review surface.';
    case 'lifecycle-not-active':
      return 'Only a current active finding can be promoted.';
    case 'already-promoted':
      return 'This finding has already been promoted.';
    case 'capability-mismatch':
      return 'This review source does not support the requested promotion destination.';
    case 'unsupported-source':
      return 'This review source keeps findings local-only.';
    case 'promotion-target-unavailable':
      return 'The durable promotion destination is unavailable.';
    case 'anchor-unavailable':
      return 'The finding anchor is unavailable on the current revision.';
    case 'confirmation-required':
      return 'Prepared-diff revision promotion requires explicit confirmation.';
    case 'promotion-pending':
      return 'This finding promotion is already in progress.';
    case 'promotion-request-conflict':
      return 'This promotion request id is already bound to different input.';
    case 'promotion-target-failed':
      return 'The durable promotion destination could not be created.';
    case 'promotion-state-changed':
      return 'The finding changed while its promotion was being created.';
  }
}

export const reviewSurfaceRegistry = new ReviewSurfaceRegistry();

export function formatReviewSurfaceServerSentEvent(
  event: ReviewSurfaceChangeEvent,
) {
  return `event: review-surface-change\ndata: ${JSON.stringify(event)}\n\n`;
}
