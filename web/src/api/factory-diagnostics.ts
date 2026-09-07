import * as v from 'valibot';
import {
  factoryHealthSchema,
  factoryTimelineSchema,
  factoryDiagnosticExportSchema,
} from '../../../shared/factory-diagnostics';
import { getJson } from './http';

export async function getFactoryHealth(workId?: string) {
  const health = v.parse(
    factoryHealthSchema,
    await getJson(
      `/api/factory/diagnostics/health${workId ? `?workId=${encodeURIComponent(workId)}` : ''}`,
    ),
  );
  if (
    workId !== undefined &&
    (health.tasks.length !== 1 || health.tasks[0].workId !== workId)
  )
    throw new Error('Diagnostic health does not match this task.');
  return health;
}
export async function getFactoryTimeline(workId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '25' });
  if (cursor) query.set('cursor', cursor);
  const timeline = v.parse(
    factoryTimelineSchema,
    await getJson(
      `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/timeline?${query}`,
    ),
  );
  if (
    timeline.workId !== workId ||
    timeline.entries.some((entry) => entry.correlation.workItemId !== workId)
  )
    throw new Error('Diagnostic timeline does not match this task.');
  return timeline;
}
export async function getFactoryDiagnosticPreview(workId: string) {
  const preview = v.parse(
    factoryDiagnosticExportSchema,
    await getJson(
      `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/preview`,
    ),
  );
  // Export IDs use a fresh server-only key: validate internal consistency,
  // not equality with the raw requested workId.
  if (
    preview.health.tasks.length !== 1 ||
    preview.health.tasks.some((task) => task.workId !== preview.workId) ||
    preview.timeline.entries.some(
      (entry) => entry.correlation.workItemId !== preview.workId,
    ) ||
    preview.diagnostics.spans.some(
      (span) => span.correlation.workItemId !== preview.workId,
    )
  )
    throw new Error(
      'Diagnostic preview contains inconsistent task identities.',
    );
  return preview;
}
