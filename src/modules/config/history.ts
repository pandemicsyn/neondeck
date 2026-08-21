import { openDb } from '../../lib/sqlite';
import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import { configEventFromChange, publishConfigEvent } from './events';
import { configJsonRecordSchema, type ConfigExternalValue } from './schemas';
import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export function recordConfigChange(
  paths: RuntimePaths,
  change: {
    action: string;
    file: string;
    target?: string;
    before: ConfigExternalValue;
    after: ConfigExternalValue;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const result = database
      .prepare(
        `
        INSERT INTO config_history (
          action,
          file,
          target,
          before_json,
          after_json,
          changed_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        change.action,
        change.file,
        change.target ?? null,
        JSON.stringify(redactLocalApiToken(asJsonValue(change.before))),
        JSON.stringify(redactLocalApiToken(asJsonValue(change.after))),
        now,
      );
    publishConfigEvent(
      configEventFromChange(paths, {
        id: result.lastInsertRowid,
        action: change.action,
        changed: true,
        files: [change.file],
        target: change.target,
        changedAt: now,
      }),
    );
  } finally {
    database.close();
  }
}

function redactLocalApiToken(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value;
  const parsedRecord = v.safeParse(configJsonRecordSchema, value);
  if (!parsedRecord.success) return value;
  const localApi = parsedRecord.output.localApi;
  if (Array.isArray(localApi)) return value;
  const parsedLocalApi = v.safeParse(configJsonRecordSchema, localApi);
  if (!parsedLocalApi.success) return value;
  return v.parse(configJsonRecordSchema, {
    ...parsedRecord.output,
    localApi: {
      ...parsedLocalApi.output,
      token: '[redacted-local-api-token]',
    },
  });
}
