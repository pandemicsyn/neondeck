import { DatabaseSync } from 'node:sqlite';

import { defaultSqliteBusyTimeoutMs } from './sqlite.ts';

const configuredPrototypeSymbol = Symbol.for(
  'neondeck.node-sqlite-defaults.prototype',
);
const prototype = DatabaseSync.prototype as typeof DatabaseSync.prototype & {
  [key: symbol]: unknown;
};

if (!prototype[configuredPrototypeSymbol]) {
  // Flue beta.9 owns its DatabaseSync handle and does not expose connection
  // options. Configure that handle immediately before its first SQL operation;
  // app-state connections still use openDb() directly.
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const configuredDatabases = new WeakSet<DatabaseSync>();
  const ensureConfigured = (database: DatabaseSync) => {
    if (configuredDatabases.has(database)) return;
    originalExec.call(
      database,
      `PRAGMA busy_timeout = ${defaultSqliteBusyTimeoutMs};`,
    );
    configuredDatabases.add(database);
  };

  DatabaseSync.prototype.exec = function exec(sql: string) {
    ensureConfigured(this);
    return originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function prepare(sql: string) {
    ensureConfigured(this);
    return originalPrepare.call(this, sql);
  };
  prototype[configuredPrototypeSymbol] = true;
}
