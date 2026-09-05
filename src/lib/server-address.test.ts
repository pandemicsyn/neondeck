import { expect, it } from 'vitest';
import {
  normalizeListenerEnv,
  privateServerHost,
  privateServerUrl,
} from './server-address';

it('normalizes loopback IPv4/IPv6 and preserves port precedence', () => {
  expect(normalizeListenerEnv({})).toEqual({
    privateHost: '127.0.0.1',
    privatePort: 3583,
    publicHost: '127.0.0.1',
    publicPort: null,
  });
  expect(
    normalizeListenerEnv({
      NEONDECK_PRIVATE_HOST: '::1',
      NEONDECK_PORT: '4000',
      PORT: '5000',
      NEONDECK_INGRESS_HOST: '0.0.0.0',
      NEONDECK_INGRESS_PORT: '6000',
    }),
  ).toEqual({
    privateHost: '::1',
    privatePort: 4000,
    publicHost: '0.0.0.0',
    publicPort: 6000,
  });
  expect(
    normalizeListenerEnv({ PORT: '5000', NEONDECK_INGRESS_PORT: '' })
      .privatePort,
  ).toBe(5000);
  expect(privateServerUrl(4000, { NEONDECK_PRIVATE_HOST: '::1' })).toBe(
    'http://[::1]:4000',
  );
});
it.each(['', '0.0.0.0', 'localhost', '[::1]'])(
  'rejects invalid private host %j consistently',
  (host) => {
    expect(() => privateServerHost({ NEONDECK_PRIVATE_HOST: host })).toThrow(
      'loopback',
    );
    expect(() => normalizeListenerEnv({ NEONDECK_PRIVATE_HOST: host })).toThrow(
      'loopback',
    );
  },
);
it.each(['', '0', '-1', '65536', 'Infinity', 'NaN', '1.5', 'abc'])(
  'rejects invalid private port %j',
  (port) => {
    expect(() =>
      normalizeListenerEnv({ NEONDECK_PORT: port, PORT: '4000' }),
    ).toThrow('between 1 and 65535');
  },
);
it.each(['0', '-1', '65536', 'Infinity', 'NaN', '1.5', 'abc'])(
  'rejects invalid ingress port %j',
  (port) => {
    expect(() => normalizeListenerEnv({ NEONDECK_INGRESS_PORT: port })).toThrow(
      'between 1 and 65535',
    );
  },
);
it('preserves endpoint bounds and rejects shared public/private ports', () => {
  expect(
    normalizeListenerEnv({ NEONDECK_PORT: '1', NEONDECK_INGRESS_PORT: '65535' })
      .publicPort,
  ).toBe(65535);
  expect(() =>
    normalizeListenerEnv({
      NEONDECK_PORT: '4000',
      NEONDECK_INGRESS_PORT: '4000',
    }),
  ).toThrow('must differ');
});
