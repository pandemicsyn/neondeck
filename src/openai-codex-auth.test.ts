import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logoutOpenAiCodexSubscription,
  openAiCodexAuthStatus,
  resolveOpenAiCodexAccessToken,
} from './modules/repos';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { resolveOpenAiCodexAccessTokenForStartup } from './server/create-app';

const tempRoots: string[] = [];
const oauthMocks = vi.hoisted(() => ({
  refresh: vi.fn<
    (refreshToken: string) => Promise<{
      access: string;
      refresh: string;
      expires: number;
    }>
  >(),
}));

vi.mock('@earendil-works/pi-ai/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai/oauth')>()),
  refreshOpenAICodexToken: oauthMocks.refresh,
}));

afterEach(async () => {
  oauthMocks.refresh.mockReset();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ChatGPT subscription authentication', () => {
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
      expect(oauthMocks.refresh).toHaveBeenCalledWith('old-refresh'),
    );
    await logoutOpenAiCodexSubscription(paths);
    deferred.resolve({
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
      expect(oauthMocks.refresh).toHaveBeenCalledWith('old-refresh'),
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
    oauthMocks.refresh.mockReturnValueOnce(new Promise(() => {}));

    await expect(
      resolveOpenAiCodexAccessTokenForStartup(paths, 5),
    ).rejects.toThrow('startup budget');
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
  let resolve!: (credentials: {
    access: string;
    refresh: string;
    expires: number;
  }) => void;
  const promise = new Promise<{
    access: string;
    refresh: string;
    expires: number;
  }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
