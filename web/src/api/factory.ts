import type { FactoryDiscussionReference } from '../../../shared/factory-planning';
import * as v from 'valibot';
import {
  factoryDetailSchema,
  factoryStateSchema,
} from '../../../shared/factory';
import { getJson, postJson } from './http';
export async function getFactoryState() {
  return v.parse(factoryStateSchema, await getJson('/api/factory/state'));
}
export async function getFactoryDetail(id: string) {
  return v.parse(
    factoryDetailSchema,
    await getJson(`/api/factory/work/${encodeURIComponent(id)}`),
  );
}
export async function mutateFactory(
  id: string | null,
  action: string,
  input: unknown,
) {
  const url = id
    ? `/api/factory/work/${encodeURIComponent(id)}/${action}`
    : '/api/factory/work';
  return v.parse(factoryDetailSchema, await postJson(url, input));
}
export async function setFactoryEnabled(enabled: boolean) {
  await postJson('/api/factory/config', {
    enabled,
    codingPolicy: 'isolated-local-v1',
  });
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
    v.object({ sessionId: v.string(), intentId: v.string() }),
    await postJson(
      `/api/factory/work/${encodeURIComponent(id)}/planning`,
      input,
    ),
  );
}
export async function recoverFactoryPlanning(id: string) {
  await postJson(
    `/api/factory/work/${encodeURIComponent(id)}/planning/recover`,
    {},
  );
}
export async function refreshFactoryPlanningContext(
  id: string,
  expectedVersion: number,
) {
  await postJson(
    `/api/factory/work/${encodeURIComponent(id)}/planning/context`,
    { expectedVersion },
  );
}

export async function stopFactoryPlanning(sessionId: string) {
  await postJson(
    `/api/flue/agents/factory-planner/${encodeURIComponent(sessionId)}/abort`,
    {},
  );
}
export async function retryFactoryTriage(id: string) {
  await postJson(`/api/factory/work/${encodeURIComponent(id)}/triage`, {});
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
  await postJson('/api/factory/github/config', {
    connections: github,
    expectedFingerprint,
  });
}
export async function syncFactorySource(id: string) {
  await postJson(`/api/factory/work/${encodeURIComponent(id)}/sync`, {});
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
