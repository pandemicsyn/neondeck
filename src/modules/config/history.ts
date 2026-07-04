import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { configEventFromChange, publishConfigEvent } from './events';

export function recordConfigChange(
  paths: RuntimePaths,
  change: {
    action: string;
    file: string;
    target?: string;
    before: unknown;
    after: unknown;
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
        JSON.stringify(redactLocalApiToken(change.before)),
        JSON.stringify(redactLocalApiToken(change.after)),
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

function redactLocalApiToken(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const localApi = record.localApi;
  if (!localApi || typeof localApi !== 'object' || Array.isArray(localApi)) {
    return value;
  }

  return {
    ...record,
    localApi: {
      ...(localApi as Record<string, unknown>),
      token: '[redacted-local-api-token]',
    },
  };
}
