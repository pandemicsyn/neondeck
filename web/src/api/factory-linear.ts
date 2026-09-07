import * as v from 'valibot';
import { factoryConfigSchema } from '../../../shared/factory';
import { factoryAcceptedSchema } from '../../../shared/factory-api';
import {
  factoryLinearStateSchema,
  type LinearConnection,
} from '../../../shared/factory-linear';
import { getJson, postJson } from './http';

export async function getFactoryLinear() {
  return v.parse(
    factoryLinearStateSchema,
    await getJson('/api/factory/linear'),
  );
}
export async function saveFactoryLinear(
  connections: LinearConnection[],
  expectedFingerprint: string,
) {
  return v.parse(
    v.required(factoryConfigSchema),
    await postJson('/api/factory/linear/config', {
      connections,
      expectedFingerprint,
    }),
  );
}
export async function syncFactoryLinearSource(workId: string) {
  return v.parse(
    factoryAcceptedSchema,
    await postJson(
      `/api/factory/work/${encodeURIComponent(workId)}/linear/sync`,
      {},
    ),
  );
}
