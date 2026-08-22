import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationChime } from './sound';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notification sound', () => {
  it('stays inert when rendered outside a browser window', () => {
    vi.stubGlobal('window', undefined);
    const chime = createNotificationChime();

    expect(() => {
      chime.unlock();
      chime.play();
      chime.close();
    }).not.toThrow();
  });
});
