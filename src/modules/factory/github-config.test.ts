import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { connectionReadiness } from './github-config';
import { connection, fixture } from './testing/github-fixture';

let setup: ReturnType<typeof fixture>;
const originalEnv = { ...process.env };
beforeEach(() => {
  setup = fixture();
});
afterEach(() => {
  setup.dispose();
  process.env = { ...originalEnv };
});

it('keeps ready polling independent of an unreadable runtime env file', () => {
  // Reading a directory as UTF-8 fails: initialized credentials need no disk read.
  unlinkSync(setup.paths.env);
  mkdirSync(setup.paths.env);
  expect(connectionReadiness(connection, setup.paths)).toEqual([]);
  expect(connectionReadiness(connection, setup.paths)).toEqual([]);
  expect(process.env[connection.webhookSecretEnv]).toBe(
    'synthetic-webhook-fixture-only',
  );
  expect(process.env[connection.tokenEnv]).toBe('synthetic-read-fixture-only');
});

it.each([undefined, ''])(
  'loads a missing or empty credential (%s) without replacing its process-supplied peer',
  (missing) => {
    if (missing === undefined) delete process.env[connection.tokenEnv];
    else process.env[connection.tokenEnv] = missing;
    writeFileSync(
      setup.paths.env,
      `${connection.tokenEnv}="synthetic runtime value"\n${connection.webhookSecretEnv}=synthetic-file-peer\n`,
    );
    expect(connectionReadiness(connection, setup.paths)).toEqual([]);
    expect(process.env[connection.tokenEnv]).toBe('synthetic runtime value');
    expect(process.env[connection.webhookSecretEnv]).toBe(
      'synthetic-webhook-fixture-only',
    );
  },
);

it('rechecks changed credential availability and retains missing-secret readiness reasons', () => {
  expect(connectionReadiness(connection, setup.paths)).toEqual([]);
  delete process.env[connection.webhookSecretEnv];
  delete process.env[connection.tokenEnv];
  expect(connectionReadiness(connection, setup.paths)).toEqual([
    'Webhook secret reference is unavailable.',
    'GitHub read credential reference is unavailable.',
  ]);
  writeFileSync(
    setup.paths.env,
    `${connection.tokenEnv}=synthetic-late-token\n${connection.webhookSecretEnv}=synthetic-late-webhook\n`,
  );
  expect(connectionReadiness(connection, setup.paths)).toEqual([]);
});
