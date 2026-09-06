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
