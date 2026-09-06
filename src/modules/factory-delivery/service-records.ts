import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { codingDigest, FactoryError } from '../factory';
import { getDeliveryPipeline, updateDeliveryPipeline } from './store';
import type { DeliveryCommand } from '../../../shared/factory-delivery';

export function requireDelivery(id: string, paths: RuntimePaths) {
  const record = getDeliveryPipeline(id, paths);
  if (!record) throw new FactoryError(404, 'Delivery not found.');
  return record;
}
export function changeDelivery(
  id: string,
  action: DeliveryCommand['action'],
  paths: RuntimePaths,
) {
  const current = requireDelivery(id, paths);
  return updateDeliveryPipeline(
    { pipelineId: id, expectedVersion: current.version, action },
    paths,
  );
}
/** Content addressed receipts are written before the corresponding durable CAS. */
export function deliveryReceipt(
  pipelineId: string,
  value: unknown,
  paths: RuntimePaths,
) {
  v.parse(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), pipelineId);
  const body = JSON.stringify(value);
  if (body.length > 1048576) throw new Error('Delivery receipt exceeds bound.');
  const directory = join(paths.home, 'factory-delivery', pipelineId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ref = join(directory, `${codingDigest(value)}.json`);
  try {
    writeFileSync(ref, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST' ||
      readFileSync(ref, 'utf8') !== body
    )
      throw error;
  }
  return ref;
}
export function interveneDelivery(
  id: string,
  kind: 'scope' | 'budget' | 'authority' | 'uncertainty',
  reason: string,
  paths: RuntimePaths,
) {
  const current = requireDelivery(id, paths);
  if (current.outcome) return current;
  const key = codingDigest({ kind, reason, revision: current.revision });
  if (current.interventions.some((i) => i.id === key)) return current;
  return changeDelivery(
    id,
    { type: 'intervene', id: key, kind, reason },
    paths,
  );
}

export function deliveryIntentPath(
  pipelineId: string,
  effectId: string,
  paths: RuntimePaths,
) {
  v.parse(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), pipelineId);
  return join(
    paths.home,
    'factory-delivery',
    pipelineId,
    `intent-${codingDigest(effectId)}.json`,
  );
}
export function saveDeliveryIntent(
  pipelineId: string,
  effectId: string,
  value: unknown,
  paths: RuntimePaths,
) {
  const ref = deliveryIntentPath(pipelineId, effectId, paths);
  mkdirSync(join(paths.home, 'factory-delivery', pipelineId), {
    recursive: true,
    mode: 0o700,
  });
  const body = JSON.stringify(value);
  if (body.length > 1048576) throw new Error('Delivery intent exceeds bound.');
  try {
    writeFileSync(ref, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST' ||
      readFileSync(ref, 'utf8') !== body
    )
      throw error;
  }
  return ref;
}
