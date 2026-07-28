import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AuthInteraction,
  OAuthCredential,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loginOpenAiCodexSubscription,
  logoutOpenAiCodexSubscription,
  openAiCodexAuthStatus,
  protectOpenAiCodexCredentialStore,
  resolveOpenAiCodexAccessToken,
} from './modules/repos';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { resolveOpenAiCodexAccessTokenForStartup } from './server/create-app';

const tempRoots: string[] = [];
const oauthMocks = vi.hoisted(() => ({
  login: vi.fn<(interaction: AuthInteraction) => Promise<OAuthCredential>>(),
  refresh: vi.fn<
    (credential: OAuthCredential) => Promise<OAuthCredential>
  >(),
  toAuth: vi.fn<
    (credential: OAuthCredential) => Promise<{ apiKey?: string }>
  >(),
}));

vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: () => ({
    auth: {
      oauth: {
        name: 'OpenAI (ChatGPT Plus/Pro)',
        login: oauthMocks.login,
        refresh: oauthMocks.refresh,
        toAuth: oauthMocks.toAuth,
      },
    },
  }),
}));

afterEach(async () => {
  oauthMocks.login.mockReset();
  oauthMocks.refresh.mockReset();
  oauthMocks.toAuth.mockReset();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ChatGPT subscription authentication', () => {
  it.each([
    {
      method: 'browser' as const,
      providerMethod: 'browser',
      notification: {
        type: 'auth_url' as const,
        url: 'https://auth.openai.test',
        instructions: 'Complete login in the browser.',
      },
    },
    {
      method: 'device-code' as const,
      providerMethod: 'device_code',
      notification: {
        type: 'device_code' as const,
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://auth.openai.test/device',
      },
    },
  ])(
    'adapts the $method login flow to the provider OAuth interface',
    async ({ method, providerMethod, notification }) => {
      const onAuth =
        vi.fn<(info: { url: string; instructions?: string }) => void>();
      const onDeviceCode =
        vi.fn<
          (info: { userCode: string; verificationUri: string }) => void
        >();
      const onProgress = vi.fn<(message: string) => void>();
      const onPrompt =
        vi
          .fn<(message: string) => Promise<string>>()
          .mockResolvedValue('manual-code');
      oauthMocks.login.mockImplementationOnce(async (interaction) => {
        await expect(
          interaction.prompt({
            type: 'select',
            message: 'Select login method',
            options: [],
          }),
        ).resolves.toBe(providerMethod);
        await expect(
          interaction.prompt({
            type: 'manual_code',
            message: 'Paste the authorization code',
          }),
        ).resolves.toBe('manual-code');
        interaction.notify(notification);
        interaction.notify({ type: 'progress', message: 'Signing in' });
        return {
          type: 'oauth',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: Date.now() + 3_600_000,
        };
      });
      const home = await mkdtemp(join(tmpdir(), 'neondeck-openai-codex-'));
      tempRoots.push(home);
      const paths = runtimePaths(home);

      await expect(
        loginOpenAiCodexSubscription(
          method,
          { onAuth, onDeviceCode, onProgress, onPrompt },
          paths,
        ),
      ).resolves.toMatchObject({
        state: 'valid',
        authenticated: true,
        usable: true,
      });

      expect(onPrompt).toHaveBeenCalledWith('Paste the authorization code');
      expect(onProgress).toHaveBeenCalledWith('Signing in');
      const expectedAuthCalls =
        notification.type === 'auth_url'
          ? [
              [
                {
                  url: notification.url,
                  instructions: notification.instructions,
                },
              ],
            ]
          : [];
      const expectedDeviceCodeCalls =
        notification.type === 'device_code'
          ? [
              [
                {
                  userCode: notification.userCode,
                  verificationUri: notification.verificationUri,
                },
              ],
            ]
          : [];
      expect(onAuth.mock.calls).toEqual(expectedAuthCalls);
      expect(onDeviceCode.mock.calls).toEqual(expectedDeviceCodeCalls);
    },
  );

  it('reads usable credentials without exposing tokens and supports logout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-openai-codex-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const expires = Date.now() + 60 * 60 * 1000;
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          INSERT INTO provider_oauth_credentials (
            provider_id,
            access_token,
            refresh_token,
            expires_at,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?);
        `,
        )
        .run(
          'openai-codex',
          'access-token',
          'refresh-token',
          expires,
          '2026-07-27T12:00:00.000Z',
          '2026-07-27T12:00:00.000Z',
        );
    } finally {
      database.close();
    }

    expect(openAiCodexAuthStatus(paths)).toMatchObject({
      state: 'valid',
      authenticated: true,
      usable: true,
      expiresAt: new Date(expires).toISOString(),
      needsRefresh: false,
      lastError: null,
    });
    await expect(resolveOpenAiCodexAccessToken(paths)).resolves.toBe(
      'access-token',
    );
    await expect(logoutOpenAiCodexSubscription(paths)).resolves.toBe(true);
    expect(openAiCodexAuthStatus(paths)).toMatchObject({
      state: 'missing',
      authenticated: false,
      usable: false,
    });
  });

  it('does not resurrect credentials removed during an in-flight refresh', async () => {
    const paths = await createCredential('old-access', 'old-refresh', 0);
    const deferred = deferredCredentials();
    oauthMocks.refresh.mockReturnValueOnce(deferred.promise);

    const resolution = resolveOpenAiCodexAccessToken(paths);
    await vi.waitFor(() =>
      expect(oauthMocks.refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'oauth',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: 0,
        }),
      ),
    );
    await logoutOpenAiCodexSubscription(paths);
    deferred.resolve({
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'rotated-refresh',
      expires: Date.now() + 3_600_000,
    });

    await expect(resolution).rejects.toThrow(
      'credentials changed or were removed',
    );
    expect(openAiCodexAuthStatus(paths).state).toBe('missing');
  });

  it('preserves a newer login that wins a concurrent token refresh', async () => {
    const paths = await createCredential('old-access', 'old-refresh', 0);
    const deferred = deferredCredentials();
    oauthMocks.refresh.mockReturnValueOnce(deferred.promise);

    const resolution = resolveOpenAiCodexAccessToken(paths);
    await vi.waitFor(() =>
      expect(oauthMocks.refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'oauth',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: 0,
        }),
      ),
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          UPDATE provider_oauth_credentials
          SET access_token = ?, refresh_token = ?, expires_at = ?, last_error = NULL
          WHERE provider_id = ?;
        `,
        )
        .run(
          'new-access',
          'new-refresh',
          Date.now() + 3_600_000,
          'openai-codex',
        );
    } finally {
      database.close();
    }
    deferred.resolve({
      type: 'oauth',
      access: 'stale-refreshed-access',
      refresh: 'stale-rotated-refresh',
      expires: Date.now() + 3_600_000,
    });

    await expect(resolution).resolves.toBe('new-access');
    await expect(resolveOpenAiCodexAccessToken(paths)).resolves.toBe(
      'new-access',
    );
  });

  it('distinguishes stored credentials that need refresh or have errors', async () => {
    const paths = await createCredential('access', 'refresh', 0);
    expect(openAiCodexAuthStatus(paths)).toMatchObject({
      state: 'refresh-needed',
      authenticated: true,
      usable: false,
    });

    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare(
          `
          UPDATE provider_oauth_credentials
          SET last_error = ?
          WHERE provider_id = ?;
        `,
        )
        .run('revoked', 'openai-codex');
    } finally {
      database.close();
    }
    expect(openAiCodexAuthStatus(paths)).toMatchObject({
      state: 'error',
      authenticated: true,
      usable: false,
      lastError: 'revoked',
    });
  });

  it('bounds startup refresh waits while leaving refresh work in flight', async () => {
    const paths = await createCredential('access', 'refresh', 0);
    const deferred = deferredCredentials();
    oauthMocks.refresh.mockReturnValueOnce(deferred.promise);

    await expect(
      resolveOpenAiCodexAccessTokenForStartup(paths, 5),
    ).rejects.toThrow('startup budget');
    deferred.resolve({
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refreshed-token',
      expires: Date.now() + 3_600_000,
    });
    await expect(resolveOpenAiCodexAccessToken(paths)).resolves.toBe(
      'refreshed-access',
    );
  });

  it('protects the database directory and existing SQLite sidecars', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-openai-codex-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const wal = `${paths.neondeckDatabase}-wal`;
    const shm = `${paths.neondeckDatabase}-shm`;
    await Promise.all([
      writeFile(wal, ''),
      writeFile(shm, ''),
      chmod(paths.data, 0o755),
    ]);
    await Promise.all([chmod(wal, 0o644), chmod(shm, 0o644)]);

    await protectOpenAiCodexCredentialStore(paths);

    expect((await stat(paths.data)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.neondeckDatabase)).mode & 0o777).toBe(0o600);
    expect((await stat(wal)).mode & 0o777).toBe(0o600);
    expect((await stat(shm)).mode & 0o777).toBe(0o600);
  });
});

async function createCredential(
  access: string,
  refresh: string,
  expires: number,
) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-openai-codex-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO provider_oauth_credentials (
          provider_id,
          access_token,
          refresh_token,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        'openai-codex',
        access,
        refresh,
        expires,
        '2026-07-27T12:00:00.000Z',
        '2026-07-27T12:00:00.000Z',
      );
  } finally {
    database.close();
  }
  return paths;
}

function deferredCredentials() {
  let resolve!: (credentials: OAuthCredential) => void;
  const promise = new Promise<OAuthCredential>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
