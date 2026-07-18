import type { SelectedLineRange } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef } from 'react';
import {
  acknowledgeReviewSurfaceNavigation,
  heartbeatReviewSurface,
  openReviewSurfaceEventStream,
  registerReviewSurface,
  removeReviewSurface,
} from '../../api';
import { reviewRevisionKey } from '../../../../shared/review-source';
import {
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceNavigationAckStatus,
  type ReviewSurfaceNavigationCommand,
  type ReviewSurfaceSnapshot,
} from '../../../../shared/review-surface';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';

const reviewSurfaceHeartbeatMs = 15_000;
let fallbackSurfaceId = 0;

type UseReviewSurfaceInput = {
  activePath: string | null;
  onNavigatePath?: (path: string, focus: boolean) => void;
  selection?: SelectedLineRange | null;
  source: ReviewSourceSnapshot;
};

export function useReviewSurface(input: UseReviewSurfaceInput | null) {
  const surfaceIdRef = useRef<string | null>(null);
  if (!surfaceIdRef.current && input) {
    surfaceIdRef.current = createReviewSurfaceId();
  }
  const surfaceId = surfaceIdRef.current;
  const activePath = input?.activePath ?? null;
  const selection = input?.selection;
  const source = input?.source ?? null;
  const snapshot = useMemo(
    () =>
      source && surfaceId
        ? createReviewSurfaceSnapshot({
            activePath,
            selection,
            source,
            surfaceId,
          })
        : null,
    [activePath, selection, source, surfaceId],
  );
  const snapshotRef = useRef(snapshot);
  const navigateRef = useRef(input?.onNavigatePath);
  const eventStreamReadyRef = useRef(false);
  snapshotRef.current = snapshot;
  navigateRef.current = input?.onNavigatePath;

  useEffect(() => {
    if (!snapshot) {
      if (surfaceId) void removeReviewSurface(surfaceId).catch(() => undefined);
      return;
    }
    if (eventStreamReadyRef.current) {
      void registerReviewSurface(snapshot).catch(() => undefined);
    }
  }, [snapshot, surfaceId]);

  useEffect(() => {
    if (!surfaceId) return;
    const heartbeat = window.setInterval(() => {
      const current = snapshotRef.current;
      if (current && eventStreamReadyRef.current) {
        void heartbeatReviewSurface(surfaceId).catch(() => {
          if (eventStreamReadyRef.current) {
            return registerReviewSurface(current).catch(() => undefined);
          }
        });
      }
    }, reviewSurfaceHeartbeatMs);
    return () => {
      window.clearInterval(heartbeat);
      void removeReviewSurface(surfaceId).catch(() => undefined);
    };
  }, [surfaceId]);

  useEffect(() => {
    if (!surfaceId) return;
    const unsubscribe = openReviewSurfaceEventStream(
      (event) => {
        const command = event.navigation;
        if (
          event.action !== 'navigation' ||
          event.surfaceId !== surfaceId ||
          !command
        ) {
          return;
        }
        const current = snapshotRef.current;
        if (!current) return;
        const result = resolveReviewSurfaceNavigation(current, command);
        if (result.status === 'resolved' && result.resolvedPath) {
          navigateRef.current?.(result.resolvedPath, command.target.focus);
          if (command.target.focus) window.focus();
        }
        void acknowledgeReviewSurfaceNavigation({
          commandId: command.commandId,
          surfaceId,
          ...result,
        }).catch(() => undefined);
      },
      () => {
        eventStreamReadyRef.current = false;
      },
      () => {
        eventStreamReadyRef.current = true;
        const current = snapshotRef.current;
        if (current) {
          void registerReviewSurface(current).catch(() => undefined);
        }
      },
    );
    return () => {
      eventStreamReadyRef.current = false;
      unsubscribe();
    };
  }, [surfaceId]);

  return surfaceId;
}

export function createReviewSurfaceSnapshot(
  input: UseReviewSurfaceInput & { surfaceId: string },
): ReviewSurfaceSnapshot {
  return {
    schemaVersion: reviewSurfaceSchemaVersion,
    surfaceId: input.surfaceId,
    source: input.source,
    activePath: input.activePath,
    selection:
      input.selection?.side && input.activePath
        ? {
            path: input.activePath,
            side: input.selection.side,
            startLine: Math.min(input.selection.start, input.selection.end),
            endLine: Math.max(input.selection.start, input.selection.end),
            endSide: input.selection.endSide ?? null,
          }
        : null,
    selectedAnnotationId: null,
    fileFilter: null,
    reviewOrder: input.source.files.map((file) => file.path),
    viewMode: 'file',
    presentationMode: 'unified',
    annotationVisibility: ['threads', 'drafts', 'findings'],
  };
}

export function resolveReviewSurfaceNavigation(
  surface: ReviewSurfaceSnapshot,
  command: ReviewSurfaceNavigationCommand,
): {
  status: ReviewSurfaceNavigationAckStatus;
  revisionKey: string | null;
  resolvedPath: string | null;
  message: string | null;
} {
  const revisionKey = reviewRevisionKey(surface.source.revision);
  if (command.revisionKey && command.revisionKey !== revisionKey) {
    return {
      status: 'stale-revision',
      revisionKey,
      resolvedPath: null,
      message: 'The review surface is showing a different revision.',
    };
  }
  const path = command.target.path;
  if (!surface.source.files.some((file) => file.path === path)) {
    return {
      status: 'target-unavailable',
      revisionKey,
      resolvedPath: null,
      message: 'The requested file is not part of this review revision.',
    };
  }
  return {
    status: 'resolved',
    revisionKey,
    resolvedPath: path,
    message: null,
  };
}

function createReviewSurfaceId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `review-surface:${crypto.randomUUID()}`;
  }
  fallbackSurfaceId += 1;
  return `review-surface:${Date.now().toString(36)}:${fallbackSurfaceId.toString(36)}`;
}
