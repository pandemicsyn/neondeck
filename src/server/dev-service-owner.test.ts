import { expect, it, vi } from 'vitest';
import type { LoadedFlueNodeApplication } from '@flue/vite';
import { createDevServiceOwner } from './dev-service-owner';

function application(): LoadedFlueNodeApplication {
  return {
    fetch: () => new Response(),
    enterActivity: () => ({ release() {} }),
    pauseAdmissions() {},
    stop: vi.fn<() => Promise<void>>(async () => {}),
    closeSync() {},
  };
}

it('starts services only after Flue loads and stops services before Flue exactly once', async () => {
  const owner = createDevServiceOwner();
  const app = application();
  const ready = Promise.withResolvers<LoadedFlueNodeApplication>();
  const drained = Promise.withResolvers<void>();
  const stop = vi.fn<() => Promise<void>>(() => drained.promise);
  const start = vi.fn<(app: LoadedFlueNodeApplication) => () => Promise<void>>(
    () => stop,
  );
  const loading = owner.load(() => ready.promise, start);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  ready.resolve(app);
  const loaded = await loading;
  expect(start).toHaveBeenCalledExactlyOnceWith(app, expect.any(Function));
  const stopping = loaded.stop(123);
  const repeated = loaded.stop();
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  expect(app.stop).not.toHaveBeenCalled();
  drained.resolve();
  await Promise.all([stopping, repeated]);
  expect(app.stop).toHaveBeenCalledExactlyOnceWith(123);
});

it('drains old workers before HMR loads and old shutdown cannot stop the replacement', async () => {
  const owner = createDevServiceOwner();
  const drained = Promise.withResolvers<void>();
  const oldStop = vi.fn<() => Promise<void>>(() => drained.promise);
  const old = await owner.load(
    async () => application(),
    () => oldStop,
  );
  const load = vi.fn<() => Promise<LoadedFlueNodeApplication>>(async () =>
    application(),
  );
  const newStop = vi.fn<() => Promise<void>>(async () => {});
  const next = owner.load(load, () => newStop);
  await Promise.resolve();
  await Promise.resolve();
  expect(oldStop).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled();
  drained.resolve();
  const replacement = await next;
  await old.stop();
  expect(oldStop).toHaveBeenCalledOnce();
  expect(newStop).not.toHaveBeenCalled();
  await replacement.stop();
  expect(newStop).toHaveBeenCalledOnce();
});

it('failed runtime loads start no workers and permit a later retry', async () => {
  const owner = createDevServiceOwner();
  const start = vi.fn<() => () => Promise<void>>(() =>
    vi.fn<() => Promise<void>>(async () => {}),
  );
  await expect(
    owner.load(async () => {
      throw new Error('load failed');
    }, start),
  ).rejects.toThrow('load failed');
  expect(start).not.toHaveBeenCalled();
  const loaded = await owner.load(async () => application(), start);
  expect(start).toHaveBeenCalledOnce();
  await loaded.stop();
});

it('serializes competing reloads and closes a runtime if service startup fails', async () => {
  const owner = createDevServiceOwner();
  const events: string[] = [];
  const first = owner.load(
    async () => application(),
    () => {
      events.push('first start');
      return async () => {
        events.push('first stop');
      };
    },
  );
  const second = owner.load(
    async () => application(),
    () => {
      events.push('second start');
      return async () => {
        events.push('second stop');
      };
    },
  );
  const [old, current] = await Promise.all([first, second]);
  expect(events).toEqual(['first start', 'first stop', 'second start']);
  await old.stop();
  await current.stop();
  const failed = application();
  await expect(
    owner.load(
      async () => failed,
      () => {
        throw new Error('startup');
      },
    ),
  ).rejects.toThrow('startup');
  expect(failed.stop).toHaveBeenCalledOnce();
});

it('still closes Flue when service drain rejects, without repeating shutdown', async () => {
  const owner = createDevServiceOwner();
  const app = application();
  const failure = new Error('drain failed');
  const drain = vi.fn<() => Promise<void>>(async () => {
    throw failure;
  });
  const loaded = await owner.load(
    async () => app,
    () => drain,
  );
  await expect(loaded.stop(42)).rejects.toBe(failure);
  await expect(loaded.stop()).rejects.toBe(failure);
  expect(drain).toHaveBeenCalledOnce();
  expect(app.stop).toHaveBeenCalledExactlyOnceWith(42);
});

it('closes old Flue once on failed HMR drain, blocks replacement, then retries cleanup on the next reload', async () => {
  const owner = createDevServiceOwner();
  const app = application();
  const failure = new Error('transient cleanup');
  const drain = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue();
  const old = await owner.load(
    async () => app,
    () => drain,
  );
  const load = vi.fn<() => Promise<LoadedFlueNodeApplication>>(async () =>
    application(),
  );
  const start = vi.fn<() => () => Promise<void>>(() => async () => {});
  await expect(owner.load(load, start)).rejects.toBe(failure);
  expect(drain).toHaveBeenCalledOnce();
  expect(app.stop).toHaveBeenCalledOnce();
  expect(load).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  const replacement = await owner.load(load, start);
  expect(drain).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledOnce();
  await old.stop();
  expect(app.stop).toHaveBeenCalledOnce();
  expect(drain).toHaveBeenCalledTimes(2);
  await replacement.stop();
});
