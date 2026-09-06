import { afterEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../runtime-home';
import { startFactoryDeliveryLoop } from './factory-delivery-loop';
afterEach(() => vi.useRealTimers());
it('waits for a settled recovery tick before scheduling, and stop drains without another tick', async () => {
  vi.useFakeTimers();
  let finish = () => {};
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startFactoryDeliveryLoop(
    runtimePaths('/private/tmp/unused-delivery-loop-test'),
    100,
    tick,
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(1);
  finish();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(tick).toHaveBeenCalledTimes(2);
  const stopping = stop();
  finish();
  await stopping;
  await vi.advanceTimersByTimeAsync(1000);
  expect(tick).toHaveBeenCalledTimes(2);
});
