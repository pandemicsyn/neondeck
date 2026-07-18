import { randomUUID } from 'node:crypto';
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

export class ReviewSurfaceRegistry {
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
          'surface' | 'navigation' | 'acknowledgement' | 'reason'
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
}

export const reviewSurfaceRegistry = new ReviewSurfaceRegistry();

export function formatReviewSurfaceServerSentEvent(
  event: ReviewSurfaceChangeEvent,
) {
  return `event: review-surface-change\ndata: ${JSON.stringify(event)}\n\n`;
}
