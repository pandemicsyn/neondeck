import { expect, it, vi } from 'vitest';
import { privateServerUrl } from '../lib/server-address';
import { rewriteServerLogLine } from './serve';
it('formats accepted loopbacks and the displayed foreground URL consistently', () => {
  expect(privateServerUrl(3583, {})).toBe('http://127.0.0.1:3583');
  expect(privateServerUrl(3583, { NEONDECK_PRIVATE_HOST: '::1' })).toBe(
    'http://[::1]:3583',
  );
  expect(() =>
    privateServerUrl(3583, { NEONDECK_PRIVATE_HOST: '0.0.0.0' }),
  ).toThrow('loopback');
  vi.stubEnv('NEONDECK_PRIVATE_HOST', '::1');
  try {
    expect(
      rewriteServerLogLine(
        '[flue] Server listening on http://localhost:3583',
        3583,
      ),
    ).toContain('http://[::1]:3583/');
  } finally {
    vi.unstubAllEnvs();
  }
});
