import * as v from 'valibot';
import {
  factoryHealthSchema,
  factoryTimelineSchema,
  factoryDiagnosticExportSchema,
} from '../../../shared/factory-diagnostics';
import { getJson } from './http';

export async function getFactoryHealth(workId?: string) {
  return v.parse(
    factoryHealthSchema,
    await getJson(
      `/api/factory/diagnostics/health${workId ? `?workId=${encodeURIComponent(workId)}` : ''}`,
    ),
  );
}
export async function getFactoryTimeline(workId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '25' });
  if (cursor) query.set('cursor', cursor);
  return v.parse(
    factoryTimelineSchema,
    await getJson(
      `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/timeline?${query}`,
    ),
  );
}
export async function getFactoryDiagnosticPreview(workId: string) {
  return v.parse(
    factoryDiagnosticExportSchema,
    await getJson(
      `/api/factory/diagnostics/tasks/${encodeURIComponent(workId)}/preview`,
    ),
  );
}
