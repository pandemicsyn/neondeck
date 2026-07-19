import type { CoordinateAutopilotAdmissionResult } from '../autopilot';
import { describe, expect, it } from 'vitest';
import {
  pendingEventResultsFromJobResult,
  triageAdmissionResultFromCoordination,
} from './pr-watch-events';

const watch = {
  id: 'pandemicsyn/neondeck#164',
  repoId: 'neondeck',
  repoFullName: 'pandemicsyn/neondeck',
  prNumber: 164,
};
const eventId = 'watch:164:review_threads:feedback';
const eventInput = { eventId, source: 'watch' as const };

describe('watch triage coordinator results', () => {
  it('reports a workflow dispatch failure with durable retry evidence and attention', () => {
    const result = triageAdmissionResultFromCoordination({
      watch,
      eventId,
      input: eventInput,
      admissionId: 'admission:164',
      coordination: coordination('dispatch-failed'),
    });

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      message: 'Autopilot triage admission failed: Flue is unavailable.',
      triage: {
        status: 'failed',
        input: { ...eventInput, admissionId: 'admission:164' },
        dispatch: {
          admissionId: 'admission:164',
          attemptId: 'attempt:164',
          attemptStatus: 'failed',
          workflow: 'triage-pr-event',
          error: 'Flue is unavailable',
        },
      },
      notifications: [
        expect.objectContaining({
          level: 'attention',
          sourceId: `triage:${watch.id}:${eventId}:dispatch-failed`,
        }),
      ],
    });
    expect(
      pendingEventResultsFromJobResult({
        eventResults: [{ watchId: watch.id, triage: result.triage! }],
      } as never),
    ).toEqual([
      expect.objectContaining({
        watchId: watch.id,
        triage: expect.objectContaining({
          status: 'failed',
          input: { ...eventInput, admissionId: 'admission:164' },
        }),
      }),
    ]);
  });

  it.each([
    ['cas-lost', true, 'cas-lost', 0],
    ['stale-reservation', true, 'stale-reservation', 0],
    ['not-reserved', true, 'not-reserved', 0],
    ['orphaned-receipt', false, 'orphaned-receipt', 1],
    ['unsupported-transport', false, 'unsupported-transport', 1],
    ['missing', false, 'missing', 1],
  ] as const)(
    'maps %s without claiming the triage workflow launched',
    (status, ok, triageStatus, notificationCount) => {
      const result = triageAdmissionResultFromCoordination({
        watch,
        eventId,
        input: eventInput,
        admissionId: 'admission:164',
        coordination: coordination(status),
      });

      expect(result).toMatchObject({
        ok,
        triage: {
          status: triageStatus,
          input: { ...eventInput, admissionId: 'admission:164' },
        },
      });
      expect(result.triage).not.toMatchObject({ status: 'admitted' });
      expect(result.notifications).toHaveLength(notificationCount);
    },
  );
});

function coordination(
  status:
    | 'cas-lost'
    | 'stale-reservation'
    | 'not-reserved'
    | 'orphaned-receipt'
    | 'unsupported-transport'
    | 'missing'
    | 'dispatch-failed',
): CoordinateAutopilotAdmissionResult {
  const context = {
    attempt: {
      id: 'attempt:164',
      status: status === 'dispatch-failed' ? 'failed' : 'reserved',
      attemptNumber: 1,
      workflow: 'triage-pr-event',
    },
    admission: {
      id: 'admission:164',
      state: 'triage-admitted',
      version: 3,
    },
  };
  const dispatched =
    status === 'missing'
      ? { status }
      : status === 'dispatch-failed'
        ? { status, error: 'Flue is unavailable', ...context }
        : status === 'orphaned-receipt'
          ? { status, runId: 'run:orphaned', ...context }
          : { status, ...context };
  return {
    advanced: { status: 'reserved' },
    dispatched,
  } as unknown as CoordinateAutopilotAdmissionResult;
}
