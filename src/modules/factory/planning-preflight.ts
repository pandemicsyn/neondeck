import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as v from 'valibot';
import type { FactoryDetail } from '../../../shared/factory';
import type { RuntimePaths } from '../../runtime-home';
import { captureContext, contextSchema } from './planning-context';

type Context = v.InferOutput<typeof contextSchema>;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function planningContextChanged(
  context: Context,
  current: FactoryDetail,
  paths: RuntimePaths,
) {
  // The pinned commit/provenance is part of the session, not a live HEAD probe.
  const { capturedAt: _freshTime, ...fresh } = captureContext(
    current,
    paths,
    context,
  );
  const { capturedAt: _oldTime, ...old } = context;
  return digest(fresh) !== digest(old);
}

/** Compare all admission inputs before/after asynchronous Git without holding
 * a database transaction during network I/O. Ignore only capture timestamps. */
export function capturePlanningGuard(
  current: FactoryDetail,
  binding: unknown,
  latest: unknown,
  paths: RuntimePaths,
) {
  const { capturedAt: _time, ...context } = captureContext(current, paths);
  return digest({
    current,
    context,
    config: readFileSync(paths.config, 'utf8'),
    binding,
    latest,
  });
}
