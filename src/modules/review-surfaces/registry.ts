import { randomUUID } from 'node:crypto';
import {
  neonReviewFindingLimits,
  type NeonReviewFinding,
  type NeonReviewFindingDraft,
  type ReviewSurfaceFindingChange,
  type ReviewSurfaceFindingsApplyRequest,
  type ReviewSurfaceFindingsClearRequest,
  type ReviewSurfaceFindingsDismissRequest,
} from '../../../shared/review-finding';
import { reviewRevisionKey } from '../../../shared/review-source';
import type {
  ActiveReviewSurface,
  ReviewSurfaceChangeEvent,
  ReviewSurfaceNavigationAck,
  ReviewSurfaceNavigationAckStatus,
  ReviewSurfaceNavigationCommand,
  ReviewSurfaceNavigationRequest,
  ReviewSurfaceSnapshot,
} from '../../../shared/review-surface';

export const reviewSurfaceTtlMs = 45_000;

type ReviewSurfaceListener = (event: ReviewSurfaceChangeEvent) => void;

type ReviewSurfaceRegistryOptions = {
  now?: () => number;
  ttlMs?: number;
};

export type ReviewSurfaceFindingErrorCode =
  | 'surface-not-active'
  | 'revision-unavailable'
  | 'stale-revision'
  | 'source-mismatch'
  | 'file-unavailable'
  | 'invalid-batch-size'
  | 'duplicate-finding-id'
  | 'finding-id-conflict'
  | 'surface-finding-limit';

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
    input: ReviewSurfaceFindingsApplyRequest,
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

    const ids = input.findings.map((finding) => finding.id);
    if (new Set(ids).size !== ids.length) {
      return this.findingError(surfaceId, 'apply', 'duplicate-finding-id', {
        revisionKey: currentRevisionKey,
      });
    }

    const sourcePaths = new Set(surface.source.files.map((file) => file.path));
    for (const finding of input.findings) {
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
    for (const finding of input.findings) {
      const current = existing.get(finding.id);
      if (current && !sameFindingDraft(current, finding)) {
        return this.findingError(surfaceId, 'apply', 'finding-id-conflict', {
          revisionKey: currentRevisionKey,
        });
      }
    }

    const newFindings = input.findings.filter(
      (finding) => !existing.has(finding.id),
    );
    if (
      existing.size + newFindings.length >
      neonReviewFindingLimits.maxFindingsPerSurface
    ) {
      return this.findingError(surfaceId, 'apply', 'surface-finding-limit', {
        revisionKey: currentRevisionKey,
      });
    }

    if (newFindings.length === 0) {
      return {
        ok: true,
        action: 'apply',
        changed: false,
        message: 'All finding ids were already applied with identical content.',
        surfaceId,
        revisionKey: currentRevisionKey,
        findings: input.findings.map((finding) => existing.get(finding.id)!),
        findingIds: [],
        count: 0,
      };
    }

    const changedAt = this.timestamp();
    const applied = newFindings.map((finding) =>
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
      findings: input.findings.map((finding) => next.get(finding.id)!),
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
      next.set(findingId, {
        ...finding,
        lifecycle: {
          state: 'dismissed',
          changedAt,
          reason: input.reason,
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
        lifecycle: { state: 'stale', changedAt, reason },
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
    lifecycle: { state: 'active', changedAt: createdAt, reason: null },
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
    case 'invalid-batch-size':
      return `Finding batches must contain between 1 and ${neonReviewFindingLimits.maxApplyBatch} items.`;
    case 'duplicate-finding-id':
      return 'Finding ids must be unique within a batch.';
    case 'finding-id-conflict':
      return 'A finding id is already associated with different content.';
    case 'surface-finding-limit':
      return `A review surface may retain at most ${neonReviewFindingLimits.maxFindingsPerSurface} ephemeral findings.`;
  }
}

export const reviewSurfaceRegistry = new ReviewSurfaceRegistry();

export function formatReviewSurfaceServerSentEvent(
  event: ReviewSurfaceChangeEvent,
) {
  return `event: review-surface-change\ndata: ${JSON.stringify(event)}\n\n`;
}
