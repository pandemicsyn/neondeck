import * as v from 'valibot';
import {
  emptyFactorySpec,
  revisionSchema,
  workSchema,
} from '../../../shared/factory';
import { factoryWorkerHealthSchema } from '../../../shared/factory-observability';
import type { TaskRecords } from './records';
export const recordedAt = '2026-09-07T12:00:00.000Z';
export function taskFixture(): TaskRecords {
  return {
    work: v.parse(workSchema, {
      id: 'work-test',
      sourceId: 'source-test',
      title: 'Private task title',
      repoId: null,
      lifecycle: 'shaping',
      version: 1,
      specVersion: 1,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    }),
    revisions: [
      v.parse(revisionSchema, {
        workId: 'work-test',
        version: 1,
        parentVersion: null,
        spec: emptyFactorySpec(),
        hash: 'a'.repeat(64),
        sourceVersion: 1,
        repoFingerprint: null,
        repoContext: null,
        authorKind: 'human',
        actor: 'private-actor',
        createdAt: recordedAt,
      }),
    ],
    releases: [],
    runs: [],
    deliveries: [],
    writeback: [],
    linearWriteback: [],
    audit: [
      {
        id: 1,
        action: 'manual-intake',
        actor: 'private-actor',
        createdAt: recordedAt,
      },
    ],
    planning: [],
    receipts: [],
    events: [],
    truncated: false,
  };
}
export function workerFixture(
  status: 'waiting' | 'stopped' | 'not-running' | 'stale' = 'waiting',
) {
  return v.parse(factoryWorkerHealthSchema, {
    worker: 'coding',
    status,
    ownerPid: null,
    lastHeartbeatAt: null,
    instanceId: null,
    startedAt: null,
    lastTickAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    nextTickAt: null,
    consecutiveFailures: 0,
    totalFailures: 0,
    staleAfterMs: 60000,
    lastError: null,
    diagnosticsDegraded: false,
  });
}
