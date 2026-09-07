import type { LoadedFlueNodeApplication } from '@flue/vite';

type Stop = () => Promise<void>;

/** Survives Vite module invalidation; replacement drains the previous workers
 * before loading a new runtime. Flue itself stops the old runtime afterward. */
export function createDevServiceOwner() {
  let queue: Promise<unknown> = Promise.resolve();
  let previous:
    { drain: Stop; close: (timeoutMs?: number) => Promise<void> } | undefined;
  return {
    load(
      load: () => Promise<LoadedFlueNodeApplication>,
      start: (
        app: LoadedFlueNodeApplication,
        ownCleanup: (stop: Stop) => void,
      ) => Stop | Promise<Stop>,
    ): Promise<LoadedFlueNodeApplication> {
      const next = queue.then(async () => {
        if (previous) {
          try {
            await previous.drain();
          } catch (error) {
            // A failed drain blocks replacement, but must not leak old Flue.
            try {
              await previous.close();
            } catch (closeError) {
              throw new AggregateError(
                [error, closeError],
                'Dev reload cleanup failed.',
              );
            }
            throw error;
          }
          previous = undefined;
        }
        const app = await load();
        let stopServices: Stop = async () => {};
        let draining: Promise<void> | undefined;
        let drained = false;
        const drain = () => {
          if (drained) return Promise.resolve();
          return (draining ??= Promise.resolve()
            .then(() => stopServices())
            .then(() => {
              drained = true;
            })
            .finally(() => {
              draining = undefined;
            }));
        };
        let closing: Promise<void> | undefined;
        const close = (timeoutMs?: number) =>
          (closing ??= Promise.resolve().then(() => app.stop(timeoutMs)));
        previous = { drain, close };
        try {
          stopServices = await start(app, (stop) => {
            stopServices = stop;
          });
        } catch (error) {
          // The starter rolls back before rejecting. Retain its registered
          // cleanup so a later reload can retry any failed rollback once.
          try {
            await close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'Dev startup cleanup failed.',
            );
          }
          throw error;
        }
        let stopping: Promise<void> | undefined;
        return {
          ...app,
          stop(timeoutMs?: number) {
            return (stopping ??= (async () => {
              const failures: unknown[] = [];
              try {
                await drain();
              } catch (error) {
                failures.push(error);
              }
              try {
                await close(timeoutMs);
              } catch (error) {
                failures.push(error);
              }
              if (failures.length === 1) throw failures[0];
              if (failures.length)
                throw new AggregateError(failures, 'Dev shutdown failed.');
            })());
          },
        };
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

declare global {
  var neondeckDevServiceOwner:
    ReturnType<typeof createDevServiceOwner> | undefined;
}

export const devServiceOwner = (globalThis.neondeckDevServiceOwner ??=
  createDevServiceOwner());
