import { currentCodingAttention } from './coding-attention';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  factoryCodingConfigInputSchema,
  factoryCodingConfigSchema,
  factoryCodingStateSchema,
  factoryCodingPageSchema,
  factoryCodingEventsSchema,
  factoryCodingLogsSchema,
  factoryCodingControlSchema,
} from '../../../shared/factory-coding';
import {
  codingRunListSchema,
  codingRunPageSchema,
} from '../../../shared/coding-runs';
import {
  listCodingRuns,
  listCodingRunEvents,
  loadLocalManifest,
  listCodingAdapters,
} from '../coding-runs';
import { updateFactoryConfig } from '../config';
import type { RuntimePaths } from '../../runtime-home';
import { codingConfig, codingDigest } from './coding-context';
import { codingReadiness } from './coding-readiness';
import {
  changeCodingRun,
  codingHandle,
  publicCodingRun,
  reconcileCodingRun,
  requireCodingRun,
  terminalCodingRun,
  type CodingHost,
} from './coding-service';
import { FactoryError } from './service';
export async function factoryCodingState(paths: RuntimePaths) {
  const readiness = await codingReadiness(paths);
  const { coding } = codingConfig(paths);
  return v.parse(factoryCodingStateSchema, {
    config: coding,
    configFingerprint: codingDigest(coding),
    readiness,
    adapters: listCodingAdapters(),
  });
}
export async function saveFactoryCodingConfig(
  input: unknown,
  paths: RuntimePaths,
) {
  const data = v.parse(factoryCodingConfigInputSchema, input);
  updateFactoryConfig({ coding: data.config }, paths, {
    precondition(before) {
      const coding = v.parse(
        factoryCodingConfigSchema,
        before.factory?.coding ?? {},
      );
      if (codingDigest(coding) !== data.expectedFingerprint)
        throw new FactoryError(
          409,
          'Coding configuration changed. Reload before saving.',
        );
    },
  });
  return factoryCodingState(paths);
}
export function factoryCodingRuns(input: unknown, paths: RuntimePaths) {
  const page = v.parse(codingRunListSchema, input);
  const rows = listCodingRuns({ ...page, order: 'desc' }, paths);
  return v.parse(factoryCodingPageSchema, {
    attention: page.workItemId
      ? currentCodingAttention(page.workItemId, paths)
      : null,
    items: rows.map((r) => ({
      sequence: r.sequence,
      run: publicCodingRun(r.record, paths),
    })),
    nextCursor: rows.length === page.limit ? rows.at(-1)!.sequence : null,
  });
}
export function factoryCodingEvents(
  id: string,
  input: unknown,
  paths: RuntimePaths,
) {
  requireCodingRun(id, paths);
  const page = v.parse(codingRunPageSchema, input);
  const rows = listCodingRunEvents(id, page, paths);
  return v.parse(factoryCodingEventsSchema, {
    items: rows,
    nextCursor: rows.length === page.limit ? rows.at(-1)!.sequence : null,
  });
}
export async function controlFactoryCoding(
  id: string,
  input: unknown,
  action: 'cancel' | 'reconcile',
  paths: RuntimePaths,
  host?: CodingHost,
) {
  const data = v.parse(factoryCodingControlSchema, input);
  let run = requireCodingRun(id, paths);
  if (run.version !== data.expectedVersion)
    throw new FactoryError(409, 'Coding run changed. Reload before acting.');
  if (action === 'cancel' && !terminalCodingRun(run) && !run.cancelRequestedAt)
    run = changeCodingRun(
      run,
      { type: 'cancel', reason: 'Cancelled by local operator.' },
      paths,
    );
  return publicCodingRun(await reconcileCodingRun(id, paths, host), paths);
}
const logInputSchema = v.strictObject({
  offset: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0)), 0),
  limit: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65536)),
    16384,
  ),
});
export async function factoryCodingLogs(
  id: string,
  input: unknown,
  paths: RuntimePaths,
) {
  const { offset, limit } = v.parse(logInputSchema, input);
  const run = requireCodingRun(id, paths);
  if (!run.host)
    return v.parse(factoryCodingLogsSchema, {
      text: '',
      nextOffset: offset,
      truncated: false,
    });
  const handle = codingHandle(run, paths);
  await loadLocalManifest(handle);
  // Never accept a filename supplied by an HTTP caller, and never follow log symlinks.
  const file = await open(
    join(handle.directory, 'stdout.jsonl'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  });
  if (!file)
    return v.parse(factoryCodingLogsSchema, {
      text: '',
      nextOffset: offset,
      truncated: false,
    });
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Invalid log file.');
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, offset);
    return v.parse(factoryCodingLogsSchema, {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      nextOffset: offset + bytesRead,
      truncated: offset + bytesRead < stat.size,
    });
  } finally {
    await file.close();
  }
}
