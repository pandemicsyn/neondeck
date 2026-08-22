import { describe, expect, it, vi } from 'vitest';
import { waitForFlueRuntime } from './create-app';

describe('Flue runtime startup', () => {
  it('waits for the generated server to configure Flue before continuing', async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error(
          '[flue] getAgentInstance() called before runtime was configured.',
        ),
      )
      .mockResolvedValueOnce();

    await expect(waitForFlueRuntime(probe, 0)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('also retries string runtime-not-configured failures', async () => {
    const probe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        '[flue] getAgentInstance() called before runtime was configured.',
      )
      .mockResolvedValueOnce();

    await expect(waitForFlueRuntime(probe, 0)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reports an already-configured runtime so reloads wait for app activation', async () => {
    const probe = vi.fn<() => Promise<void>>().mockResolvedValueOnce();

    await expect(waitForFlueRuntime(probe, 0)).resolves.toBe(false);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('does not conceal permanent runtime or registration failures', async () => {
    const failure = new Error(
      '[flue] getAgentInstance() target agent is not registered.',
    );

    await expect(
      waitForFlueRuntime(async () => Promise.reject(failure), 0),
    ).rejects.toBe(failure);
  });
});
