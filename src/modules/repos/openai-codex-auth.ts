import {
  type AuthInteraction,
  type OAuthAuth,
  type OAuthCredential,
  type OAuthCredentials,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { chmod } from 'node:fs/promises';
import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

export type OpenAiCodexLoginMethod = 'browser' | 'device-code';
export type OpenAiCodexLoginCallbacks = {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  onPrompt?: (message: string) => Promise<string>;
  onProgress?: (message: string) => void;
};

export type OpenAiCodexAuthState =
  'missing' | 'valid' | 'refresh-needed' | 'error';

export type OpenAiCodexAuthStatus = {
  state: OpenAiCodexAuthState;
  authenticated: boolean;
  usable: boolean;
  expiresAt: string | null;
  needsRefresh: boolean;
  lastError: string | null;
  updatedAt: string | null;
};

type StoredCredential = OAuthCredentials & {
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const providerId = 'openai-codex';
const refreshSkewMs = 60_000;
const refreshes = new Map<string, Promise<OAuthCredentials>>();
const refreshTimers = new Map<string, NodeJS.Timeout>();
const openAiCodexOAuth = requireOpenAiCodexOAuth();

function requireOpenAiCodexOAuth(): OAuthAuth {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) {
    throw new Error('OpenAI Codex provider does not support OAuth.');
  }
  return oauth;
}

export async function loginOpenAiCodexSubscription(
  method: OpenAiCodexLoginMethod,
  callbacks: OpenAiCodexLoginCallbacks,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  await protectOpenAiCodexCredentialStore(paths);
  const credentials = await openAiCodexOAuth.login(
    openAiCodexLoginInteraction(method, callbacks),
  );
  writeLoginCredential(paths, credentials);
  return openAiCodexAuthStatus(paths);
}

function openAiCodexLoginInteraction(
  method: OpenAiCodexLoginMethod,
  callbacks: OpenAiCodexLoginCallbacks,
): AuthInteraction {
  return {
    async prompt(prompt) {
      if (prompt.type === 'select') {
        return method === 'device-code' ? 'device_code' : 'browser';
      }
      return callbacks.onPrompt?.(prompt.message) ?? '';
    },
    notify(event) {
      switch (event.type) {
        case 'auth_url':
          callbacks.onAuth?.(
            event.instructions
              ? { url: event.url, instructions: event.instructions }
              : { url: event.url },
          );
          break;
        case 'device_code':
          callbacks.onDeviceCode?.({
            userCode: event.userCode,
            verificationUri: event.verificationUri,
          });
          break;
        case 'info':
        case 'progress':
          callbacks.onProgress?.(event.message);
          break;
      }
    },
  };
}

export async function resolveOpenAiCodexAccessToken(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  await protectOpenAiCodexCredentialStore(paths);
  const credential = readCredential(paths);
  if (!credential) return undefined;
  if (credential.expires > Date.now() + refreshSkewMs) {
    return credential.access;
  }

  const key = paths.neondeckDatabase;
  let pending = refreshes.get(key);
  if (!pending) {
    pending = refreshCredential(paths, credential);
    refreshes.set(key, pending);
    void pending.then(
      () => {
        if (refreshes.get(key) === pending) refreshes.delete(key);
      },
      () => {
        if (refreshes.get(key) === pending) refreshes.delete(key);
      },
    );
  }
  return (await pending).access;
}

export function startOpenAiCodexTokenRefresh(
  paths: RuntimePaths,
  onToken: (accessToken: string) => void,
) {
  const key = paths.neondeckDatabase;
  const existing = refreshTimers.get(key);
  if (existing) clearTimeout(existing);

  const schedule = (retryDelay?: number) => {
    const status = openAiCodexAuthStatus(paths);
    if (!status.authenticated || !status.expiresAt) return;
    const delay =
      retryDelay ??
      Math.max(
        1_000,
        Math.min(
          new Date(status.expiresAt).getTime() - Date.now() - refreshSkewMs,
          2_147_000_000,
        ),
      );
    const timer = setTimeout(() => {
      void resolveOpenAiCodexAccessToken(paths)
        .then((token) => {
          if (token) onToken(token);
          schedule();
        })
        .catch((error) => {
          console.warn(
            '[neondeck] ChatGPT subscription token refresh failed',
            error,
          );
          schedule(60_000);
        });
    }, delay);
    timer.unref();
    refreshTimers.set(key, timer);
  };

  schedule();
}

export function openAiCodexAuthStatus(
  paths: RuntimePaths = runtimePaths(),
): OpenAiCodexAuthStatus {
  const credential = readCredential(paths);
  const needsRefresh = credential
    ? credential.expires <= Date.now() + refreshSkewMs
    : false;
  const state: OpenAiCodexAuthState = !credential
    ? 'missing'
    : credential.lastError
      ? 'error'
      : needsRefresh
        ? 'refresh-needed'
        : 'valid';
  return {
    state,
    authenticated: Boolean(credential),
    usable: state === 'valid',
    expiresAt: credential ? new Date(credential.expires).toISOString() : null,
    needsRefresh,
    lastError: credential?.lastError ?? null,
    updatedAt: credential?.updatedAt ?? null,
  };
}

export async function logoutOpenAiCodexSubscription(
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  await protectOpenAiCodexCredentialStore(paths);
  const key = paths.neondeckDatabase;
  const timer = refreshTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(key);
  }
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          'DELETE FROM provider_oauth_credentials WHERE provider_id = ?;',
        )
        .run(providerId).changes > 0
    );
  } finally {
    database.close();
  }
}

async function refreshCredential(
  paths: RuntimePaths,
  credential: StoredCredential,
) {
  let refreshed: OAuthCredentials;
  try {
    refreshed = await openAiCodexOAuth.refresh(
      canonicalOAuthCredential(credential),
    );
  } catch (error) {
    const latest = readCredential(paths);
    if (latest && latest.refresh !== credential.refresh) {
      return latest;
    }
    writeCredentialError(paths, credential.refresh, errorMessage(error));
    throw new Error(
      `ChatGPT subscription authentication expired or was revoked. Run "neondeck auth login openai-codex" to sign in again. ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (replaceRefreshedCredential(paths, credential.refresh, refreshed)) {
    return refreshed;
  }

  const latest = readCredential(paths);
  if (latest) return latest;
  throw new Error(
    'ChatGPT subscription credentials changed or were removed while a token refresh was in progress.',
  );
}

function canonicalOAuthCredential(
  credential: OAuthCredentials,
): OAuthCredential {
  return {
    ...credential,
    type: 'oauth',
  };
}

function readCredential(paths: RuntimePaths): StoredCredential | undefined {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT
          access_token,
          refresh_token,
          expires_at,
          last_error,
          created_at,
          updated_at
        FROM provider_oauth_credentials
        WHERE provider_id = ?;
      `,
      )
      .get(providerId) as
      | {
          access_token: string;
          refresh_token: string;
          expires_at: number;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          access: row.access_token,
          refresh: row.refresh_token,
          expires: row.expires_at,
          lastError: row.last_error,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  } finally {
    database.close();
  }
}

function writeLoginCredential(
  paths: RuntimePaths,
  credential: OAuthCredentials,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO provider_oauth_credentials (
          provider_id,
          access_token,
          refresh_token,
          expires_at,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          last_error = NULL,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        providerId,
        credential.access,
        credential.refresh,
        credential.expires,
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function replaceRefreshedCredential(
  paths: RuntimePaths,
  expectedRefreshToken: string,
  credential: OAuthCredentials,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          `
          UPDATE provider_oauth_credentials
          SET
            access_token = ?,
            refresh_token = ?,
            expires_at = ?,
            last_error = NULL,
            updated_at = ?
          WHERE provider_id = ? AND refresh_token = ?;
        `,
        )
        .run(
          credential.access,
          credential.refresh,
          credential.expires,
          new Date().toISOString(),
          providerId,
          expectedRefreshToken,
        ).changes > 0
    );
  } finally {
    database.close();
  }
}

function writeCredentialError(
  paths: RuntimePaths,
  expectedRefreshToken: string,
  message: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE provider_oauth_credentials
        SET last_error = ?, updated_at = ?
        WHERE provider_id = ? AND refresh_token = ?;
      `,
      )
      .run(message, new Date().toISOString(), providerId, expectedRefreshToken);
  } finally {
    database.close();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function protectOpenAiCodexCredentialStore(paths: RuntimePaths) {
  // The access and refresh tokens may live in SQLite's WAL rather than the
  // main database. Make the containing directory private first so sidecars
  // created after this point are also inaccessible to other local users.
  await chmod(paths.data, 0o700);
  await Promise.all(
    [
      paths.neondeckDatabase,
      `${paths.neondeckDatabase}-wal`,
      `${paths.neondeckDatabase}-shm`,
    ].map((path) => chmodIfPresent(path, 0o600)),
  );
}

async function chmodIfPresent(path: string, mode: number) {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}
