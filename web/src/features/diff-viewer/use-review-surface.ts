import type { SelectedLineRange } from '@pierre/diffs/react';
import { useEffect, useMemo, useRef } from 'react';
import {
  acknowledgeReviewSurfaceNavigation,
  heartbeatReviewSurface,
  openReviewSurfaceEventStream,
  registerReviewSurface,
  readReviewSurfaceFindings,
  removeReviewSurface,
} from '../../api';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { reviewRevisionKey } from '../../../../shared/review-source';
import {
  reviewSurfaceSchemaVersion,
  type ReviewSurfaceNavigationAckStatus,
  type ReviewSurfaceNavigationCommand,
  type ReviewSurfaceSnapshot,
} from '../../../../shared/review-surface';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import {
  createReviewRefreshStatus,
  type ReviewRefreshStatus,
} from '../../../../shared/review-refresh';

const reviewSurfaceHeartbeatMs = 15_000;
let fallbackSurfaceId = 0;

type UseReviewSurfaceInput = {
  activePath: string | null;
  fileFilter?: string | null;
  onNavigatePath?: (path: string, focus: boolean) => void;
  onFindingsChange?: (surfaceId: string, findings: NeonReviewFinding[]) => void;
  onSurfaceIdChange?: (surfaceId: string | null) => void;
  reviewOrder?: readonly string[];
  selectedAnnotationId?: string | null;
  selection?: SelectedLineRange | null;
  source: ReviewSourceSnapshot;
  refresh?: ReviewRefreshStatus;
};

export function useReviewSurface(input: UseReviewSurfaceInput | null) {
  const surfaceIdRef = useRef<string | null>(null);
  if (!surfaceIdRef.current && input) {
    surfaceIdRef.current = createReviewSurfaceId();
  }
  const surfaceId = surfaceIdRef.current;
  const activePath = input?.activePath ?? null;
  const fileFilter = input?.fileFilter ?? null;
  const reviewOrder = input?.reviewOrder;
  const selectedAnnotationId = input?.selectedAnnotationId ?? null;
  const selection = input?.selection;
  const source = input?.source ?? null;
  const snapshot = useMemo(
    () =>
      source && surfaceId
        ? createReviewSurfaceSnapshot({
            activePath,
            fileFilter,
            reviewOrder,
            selectedAnnotationId,
            selection,
            source,
            surfaceId,
          })
        : null,
    [
      activePath,
      fileFilter,
      reviewOrder,
      selectedAnnotationId,
      selection,
      source,
      surfaceId,
    ],
  );
  const snapshotRef = useRef(snapshot);
  const navigateRef = useRef(input?.onNavigatePath);
  const findingsChangeRef = useRef(input?.onFindingsChange);
  const findingsRequestGenerationRef = useRef(0);
  const surfaceIdChangeRef = useRef(input?.onSurfaceIdChange);
  const eventStreamReadyRef = useRef(false);
  snapshotRef.current = snapshot;
  navigateRef.current = input?.onNavigatePath;
  findingsChangeRef.current = input?.onFindingsChange;
  surfaceIdChangeRef.current = input?.onSurfaceIdChange;

  useEffect(() => {
    surfaceIdChangeRef.current?.(surfaceId);
    return () => surfaceIdChangeRef.current?.(null);
  }, [surfaceId]);

  useEffect(() => {
    if (!snapshot) {
      findingsRequestGenerationRef.current += 1;
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
            return registerReviewSurface(current)
              .then(() => syncReviewSurfaceFindings(surfaceId))
              .catch(() => undefined);
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
          event.surfaceId === surfaceId &&
          event.action === 'findings-changed'
        ) {
          void syncReviewSurfaceFindings(surfaceId);
        }
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
          void registerReviewSurface(current)
            .then(() => syncReviewSurfaceFindings(surfaceId))
            .catch(() => undefined);
        }
      },
    );
    return () => {
      eventStreamReadyRef.current = false;
      findingsRequestGenerationRef.current += 1;
      unsubscribe();
    };
  }, [surfaceId]);

  return surfaceId;

  function syncReviewSurfaceFindings(targetSurfaceId: string) {
    if (!findingsChangeRef.current) return Promise.resolve();
    const requestedSnapshot = snapshotRef.current;
    if (!requestedSnapshot || requestedSnapshot.surfaceId !== targetSurfaceId) {
      return Promise.resolve();
    }
    const requestGeneration = ++findingsRequestGenerationRef.current;
    const requestedRevisionKey = reviewRevisionKey(
      requestedSnapshot.source.revision,
    );
    const requestedSourceId = requestedSnapshot.source.id;
    return readReviewSurfaceFindings(targetSurfaceId).then((result) => {
      const currentSnapshot = snapshotRef.current;
      if (
        requestGeneration !== findingsRequestGenerationRef.current ||
        !currentSnapshot ||
        currentSnapshot.surfaceId !== targetSurfaceId ||
        currentSnapshot.source.id !== requestedSourceId ||
        reviewRevisionKey(currentSnapshot.source.revision) !==
          requestedRevisionKey ||
        result.surfaceId !== targetSurfaceId ||
        result.revisionKey !== requestedRevisionKey
      ) {
        return;
      }
      findingsChangeRef.current?.(targetSurfaceId, result.findings);
    });
  }
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
    selectedAnnotationId: input.selectedAnnotationId ?? null,
    fileFilter: input.fileFilter?.trim() || null,
    reviewOrder: input.reviewOrder
      ? [...input.reviewOrder]
      : input.source.files.map((file) => file.path),
    viewMode: 'file',
    presentationMode: 'unified',
    annotationVisibility: ['threads', 'drafts', 'findings'],
    refresh:
      input.refresh ??
      createReviewRefreshStatus({ appliedRevision: input.source.revision }),
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
