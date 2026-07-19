import './lib/node-sqlite-defaults.ts';

import { sqlite } from '@flue/runtime/node';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { ensureRuntimeHomeSync, runtimePaths } from './runtime-home';

const flueLongPollGraceMs = 5_000;
const paths = runtimePaths();
ensureRuntimeHomeSync(paths);

export default delayClose(sqlite(paths.flueDatabase), flueLongPollGraceMs);

function delayClose(
  adapter: PersistenceAdapter,
  delayMs: number,
): PersistenceAdapter {
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelPendingClose() {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  return {
    async migrate() {
      cancelPendingClose();
      await adapter.migrate?.();
    },
    async connect() {
      cancelPendingClose();
      return adapter.connect();
    },
    close() {
      cancelPendingClose();
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        void adapter.close?.();
      }, delayMs);
      closeTimer.unref?.();
    },
  };
}
