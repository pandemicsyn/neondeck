import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../runtime-home';
import { createDevServiceOwner } from './dev-service-owner';
import type { LoadedFlueNodeApplication } from '@flue/vite';
import { startManagedServices } from './managed-services';

const effects = vi.hoisted(() => ({
  codingStop: vi.fn<() => Promise<void>>(async () => {}),
  deliveryStop: vi.fn<() => Promise<void>>(async () => {}),
  githubStop: vi.fn<() => Promise<void>>(async () => {}),
  linearStop: vi.fn<() => Promise<void>>(async () => {}),
  coding: vi.fn<(...args: unknown[]) => void>(),
  delivery: vi.fn<(...args: unknown[]) => void>(),
  github: vi.fn<(...args: unknown[]) => void>(),
  linear: vi.fn<(...args: unknown[]) => void>(),
  recover: vi.fn<() => Promise<void>>(),
  mcpStart: vi.fn<() => Promise<void>>(async () => {}),
  updateStop: vi.fn<() => void>(),
  schedulerStop: vi.fn<() => Promise<void>>(async () => {}),
  mcpStop: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock('./factory-coding-loop', () => ({
  startFactoryCodingLoop: (...args: unknown[]) => {
    effects.coding(...args);
    return effects.codingStop;
  },
}));
vi.mock('./factory-delivery-loop', () => ({
  startFactoryDeliveryLoop: (...args: unknown[]) => {
    effects.delivery(...args);
    return effects.deliveryStop;
  },
}));
vi.mock('./factory-github-loop', () => ({
  startFactoryGitHubLoop: (...args: unknown[]) => {
    effects.github(...args);
    return effects.githubStop;
  },
}));
vi.mock('./factory-linear-loop', () => ({
  startFactoryLinearLoop: (...args: unknown[]) => {
    effects.linear(...args);
    return effects.linearStop;
  },
}));
vi.mock('./create-app', () => ({
  recoverFlueRuntimeServices: effects.recover,
}));
vi.mock('../domains/mcp', () => ({
  getMcpRegistry: () => ({ start: effects.mcpStart, stop: effects.mcpStop }),
}));
vi.mock('../modules/updates/loop', () => ({
  startUpdateCheckLoop() {},
  stopUpdateCheckLoop: effects.updateStop,
}));
vi.mock('./scheduler-loop', () => ({
  startSchedulerLoop() {},
  stopSchedulerLoop: effects.schedulerStop,
}));
vi.mock('../modules/github', () => ({
  refreshGitHubQueueSnapshot: async () => {},
}));
vi.mock('../modules/pr-reviews', () => ({
  refreshPrReviewRemoteState: async () => {},
}));
beforeEach(() => {
  vi.resetAllMocks();
  effects.recover.mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('starts all factory loops once across recovery retries, and drains them on stop', async () => {
  vi.useFakeTimers();
  effects.recover.mockRejectedValueOnce(new Error('retry')).mockResolvedValue();
  const paths = runtimePaths('/tmp/mocked-dev-managed-services');
  const stop = await startManagedServices(paths, {
    fetch: async () => new Response(),
  });
  await vi.advanceTimersByTimeAsync(30000);
  expect(effects.recover).toHaveBeenCalledTimes(2);
  for (const start of [
    effects.coding,
    effects.delivery,
    effects.github,
    effects.linear,
  ])
    expect(start).toHaveBeenCalledExactlyOnceWith(paths);
  await stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(effects.recover).toHaveBeenCalledTimes(2);
  for (const drain of [
    effects.codingStop,
    effects.deliveryStop,
    effects.githubStop,
    effects.linearStop,
    effects.mcpStop,
  ])
    expect(drain).toHaveBeenCalledOnce();
});

it('rolls back all earlier workers if Linear startup fails', async () => {
  const paths = runtimePaths('/tmp/mocked-dev-linear-startup-rollback');
  effects.linear.mockImplementationOnce(() => {
    throw new Error('Linear startup failed');
  });
  const owned = vi.fn<(stop: () => Promise<void>) => void>();
  await expect(
    startManagedServices(
      paths,
      {
        fetch: async () => new Response(),
      },
      owned,
    ),
  ).rejects.toThrow('Linear startup failed');
  expect(owned).toHaveBeenCalledOnce();
  for (const drain of [
    effects.codingStop,
    effects.deliveryStop,
    effects.githubStop,
    effects.updateStop,
    effects.schedulerStop,
    effects.mcpStop,
  ])
    expect(drain).toHaveBeenCalledOnce();
  expect(effects.linearStop).not.toHaveBeenCalled();
  const stop = await startManagedServices(paths, {
    fetch: async () => new Response(),
  });
  await stop();
  expect(effects.linearStop).toHaveBeenCalledOnce();
});

it('rolls back earlier services and MCP when a later starter throws before retrying', async () => {
  const paths = runtimePaths('/tmp/mocked-dev-startup-rollback');
  const owner = createDevServiceOwner();
  let activeCoding = 0;
  effects.coding.mockImplementation(() => {
    expect(activeCoding).toBe(0);
    activeCoding++;
  });
  effects.codingStop.mockImplementation(async () => {
    activeCoding--;
  });
  effects.github.mockImplementationOnce(() => {
    throw new Error('late starter failed');
  });
  const close = vi.fn<() => Promise<void>>(async () => {});
  const app: LoadedFlueNodeApplication = {
    fetch: async () => new Response(),
    stop: close,
    pauseAdmissions() {},
    closeSync() {},
    enterActivity: () => ({ release() {} }),
  };
  await expect(
    owner.load(
      async () => app,
      (app, own) => startManagedServices(paths, app, own),
    ),
  ).rejects.toThrow('late starter failed');
  expect(activeCoding).toBe(0);
  for (const stop of [
    effects.codingStop,
    effects.deliveryStop,
    effects.updateStop,
    effects.schedulerStop,
    effects.mcpStop,
    close,
  ])
    expect(stop).toHaveBeenCalledOnce();
  expect(effects.githubStop).not.toHaveBeenCalled();
  const replacement = await owner.load(
    async () => ({ ...app, stop: async () => {} }),
    (app, own) => startManagedServices(paths, app, own),
  );
  expect(activeCoding).toBe(1);
  await replacement.stop();
  expect(activeCoding).toBe(0);
  effects.coding.mockReset();
  effects.codingStop.mockImplementation(async () => {});
});

it('retains failed rollback ownership and retries only failed cleanup before any new startup', async () => {
  const paths = runtimePaths('/tmp/mocked-dev-rollback-retry');
  const owner = createDevServiceOwner();
  effects.github.mockImplementationOnce(() => {
    throw new Error('startup');
  });
  effects.codingStop
    .mockRejectedValueOnce(new Error('cleanup'))
    .mockRejectedValueOnce(new Error('still pending'))
    .mockResolvedValue();
  const app: LoadedFlueNodeApplication = {
    fetch: async () => new Response(),
    stop: vi.fn<() => Promise<void>>(async () => {}),
    pauseAdmissions() {},
    closeSync() {},
    enterActivity: () => ({ release() {} }),
  };
  const start = (
    app: LoadedFlueNodeApplication,
    own: (stop: () => Promise<void>) => void,
  ) => startManagedServices(paths, app, own);
  await expect(owner.load(async () => app, start)).rejects.toThrow(
    'startup and rollback failed',
  );
  const load = vi.fn<() => Promise<LoadedFlueNodeApplication>>(async () => ({
    ...app,
    stop: async () => {},
  }));
  await expect(owner.load(load, start)).rejects.toThrow('cleanup failed');
  expect(load).not.toHaveBeenCalled();
  expect(effects.coding).toHaveBeenCalledOnce();
  expect(effects.codingStop).toHaveBeenCalledTimes(2);
  expect(effects.deliveryStop).toHaveBeenCalledOnce();
  expect(effects.mcpStop).toHaveBeenCalledOnce();
  expect(app.stop).toHaveBeenCalledOnce();
  const replacement = await owner.load(load, start);
  expect(effects.codingStop).toHaveBeenCalledTimes(3);
  expect(effects.coding).toHaveBeenCalledTimes(2);
  await replacement.stop();
});
