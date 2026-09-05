import type { FactoryDiscussionReference } from '../../../shared/factory-planning';
import * as v from 'valibot';
import {
  factoryConfigSchema,
  factoryStateSchema,
} from '../../../shared/factory';
import {
  factoryDetailViewSchema,
  factoryAcceptedSchema,
  factoryAbortSchema,
  factoryPlanningAdmissionSchema,
  type FactoryMutationArgs,
} from '../../../shared/factory-api';
import { planningStateSchema } from '../../../shared/factory-planning';
import {
  writebackPolicySchema,
  publicApprovalSchema,
  writebackStateSchema,
} from '../../../shared/factory-writeback';
export type { FactoryMutationArgs } from '../../../shared/factory-api';
import { getJson, postJson } from './http';
export async function getFactoryState() {
  return v.parse(factoryStateSchema, await getJson('/api/factory/state'));
}
export async function getFactoryDetail(id: string) {
  return v.parse(
    factoryDetailViewSchema,
    await getJson(`/api/factory/work/${encodeURIComponent(id)}`),
  );
}
export async function mutateFactory(
  id: string | null,
  ...[action, input]: FactoryMutationArgs
) {
  const url = id
    ? `/api/factory/work/${encodeURIComponent(id)}/${action}`
    : '/api/factory/work';
  return v.parse(factoryDetailViewSchema, await postJson(url, input));
}
export async function setFactoryEnabled(enabled: boolean) {
  return v.parse(
    v.required(factoryConfigSchema),
    await postJson('/api/factory/config', {
      enabled,
      codingPolicy: 'isolated-local-v1',
    }),
  );
}

export { dashboardEventHub } from './event-hub';

export async function getFactoryPlanning(id: string) {
  const { planningStateSchema } =
    await import('../../../shared/factory-planning');
  return v.parse(
    planningStateSchema,
    await getJson(`/api/factory/work/${encodeURIComponent(id)}/planning`),
  );
}
export async function sendFactoryPlanning(
  id: string,
  input: {
    requestKey: string;
    expectedVersion: number;
    message: string;
    discussion?: FactoryDiscussionReference;
  },
) {
  return v.parse(
    factoryPlanningAdmissionSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/planning`,
      input,
    ),
  );
}
export async function recoverFactoryPlanning(id: string) {
  return v.parse(
    planningStateSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/planning/recover`,
      {},
    ),
  );
}
export async function refreshFactoryPlanningContext(
  id: string,
  expectedVersion: number,
) {
  return v.parse(
    planningStateSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/planning/context`,
      { expectedVersion },
    ),
  );
}

export async function stopFactoryPlanning(sessionId: string) {
  return v.parse(
    factoryAbortSchema,
    await postJson(
      `/api/flue/agents/factory-planner/${encodeURIComponent(sessionId)}/abort`,
      {},
    ),
  );
}
export async function retryFactoryTriage(id: string) {
  return v.parse(
    planningStateSchema,
    await postJson(`/api/factory/work/${encodeURIComponent(id)}/triage`, {}),
  );
}

export async function getFactoryGitHub() {
  const { factoryGitHubStateSchema } =
    await import('../../../shared/factory-github');
  return v.parse(
    factoryGitHubStateSchema,
    await getJson('/api/factory/github'),
  );
}
export async function saveFactoryGitHub(
  github: import('../../../shared/factory-github').GitHubConnection[],
  expectedFingerprint: string,
) {
  return v.parse(
    v.required(factoryConfigSchema),
    await postJson('/api/factory/github/config', {
      connections: github,
      expectedFingerprint,
    }),
  );
}
export async function syncFactorySource(id: string) {
  return v.parse(
    factoryAcceptedSchema,
    await postJson(`/api/factory/work/${encodeURIComponent(id)}/sync`, {}),
  );
}

export async function getFactoryWriteback(id: string) {
  const { writebackStateSchema } =
    await import('../../../shared/factory-writeback');
  return v.parse(
    writebackStateSchema,
    await getJson(`/api/factory/work/${encodeURIComponent(id)}/writeback`),
  );
}
export async function setFactoryWriteback(
  connectionId: string,
  input: {
    enabled: boolean;
    expectedEpoch: string;
    expectedFingerprint: string;
  },
) {
  return v.parse(
    writebackPolicySchema,
    await postJson(
      `/api/factory/github/${encodeURIComponent(connectionId)}/writeback`,
      input,
    ),
  );
}
export async function approveFactoryWriteback(
  id: string,
  input: import('../../../shared/factory-writeback').WritebackApprovalInput,
) {
  return v.parse(
    publicApprovalSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/writeback/approve`,
      input,
    ),
  );
}
export async function recoverFactoryWriteback(
  id: string,
  effectId: string,
  action: 'retry' | 'relinquish',
) {
  return v.parse(
    writebackStateSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/writeback/recover`,
      { effectId, action },
    ),
  );
}
export async function previewFactoryWritebackRepair(
  id: string,
  effectId: string,
) {
  const { writebackRepairSchema } =
    await import('../../../shared/factory-writeback');
  return v.parse(
    writebackRepairSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/writeback/repair-preview`,
      { effectId },
    ),
  );
}
export async function approveFactoryWritebackRepair(
  id: string,
  previewId: string,
  replacement: string,
) {
  return v.parse(
    writebackStateSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/writeback/repair`,
      { previewId, replacement },
    ),
  );
}

export async function getFactoryGitHubComments(id: string, cursor?: string) {
  const { factoryGitHubCommentsSchema } =
    await import('../../../shared/factory-github');
  return v.parse(
    factoryGitHubCommentsSchema,
    await getJson(
      `/api/factory/work/${encodeURIComponent(id)}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  );
}
