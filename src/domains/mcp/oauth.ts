import { openDb } from '../../lib/sqlite.ts';
import { randomUUID } from 'node:crypto';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { readMcpConfig } from './config';
import type { McpServerConfig } from './schemas';
import {
  expireMcpServerApprovals,
  expireMcpServerApprovalsSync,
} from './store';

export type McpOAuthLoginStatus =
  'pending' | 'redirect' | 'authorized' | 'failed' | 'expired';

export type McpOAuthLoginRecord = {
  id: string;
  serverId: string;
  serverIdentity: string | null;
  state: string;
  status: McpOAuthLoginStatus;
  redirectUrl: string;
  authorizationUrl: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  updatedAt: string;
};

export type PublicMcpOAuthLoginRecord = Omit<
  McpOAuthLoginRecord,
  'state' | 'serverIdentity'
>;

export type McpOAuthStatus = {
  authorized: boolean;
  expiresAt: string | null;
  scopes: string[];
  updatedAt: string | null;
};

type TokenState = {
  serverIdentity: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenType: string | null;
  idToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  clientInformation: OAuthClientInformationMixed | null;
  discoveryState: OAuthDiscoveryState | null;
  codeVerifier: string | null;
  updatedAt: string | null;
};

const defaultCallbackUrl = 'http://127.0.0.1:3583/api/mcp/oauth/callback';
const loginTtlMs = 10 * 60 * 1000;

export async function startMcpOAuthLogin(
  input: { id: string; redirectUrl?: string },
  paths = runtimePaths(),
) {
  let login: McpOAuthLoginRecord | null = null;
  try {
    const { server } = await requireOAuthServer(input.id, paths);
    const redirectUrl = input.redirectUrl ?? defaultCallbackUrl;
    if (!isAllowedOAuthRedirectUrl(redirectUrl)) {
      return {
        ok: false,
        action: 'mcp_login_start',
        changed: false,
        message:
          'MCP OAuth redirects must use the local /api/mcp/oauth/callback route on a loopback host.',
        requires: ['redirectUrl'],
      };
    }
    login = await createOAuthLogin(
      input.id,
      redirectUrl,
      oauthServerIdentity(server),
      paths,
    );
    const provider = new NeondeckMcpOAuthProvider({
      paths,
      serverId: input.id,
      server,
      redirectUrl,
      state: login.state,
    });
    const result = await auth(provider, { serverUrl: server.url });
    const updated = await readMcpOAuthLogin(login.id, paths);
    if (result === 'AUTHORIZED') {
      if (!(await markOAuthLoginAuthorized(login.id, paths))) {
        return inactiveOAuthLoginResult(login.id, paths);
      }
      return {
        ok: true,
        action: 'mcp_login_start',
        changed: true,
        message: `MCP server "${input.id}" is authorized.`,
        login: await readPublicMcpOAuthLogin(login.id, paths),
        authorized: true,
      };
    }

    return {
      ok: true,
      action: 'mcp_login_start',
      changed: true,
      message: `Open the authorization URL to finish MCP login for "${input.id}".`,
      login: publicMcpOAuthLogin(updated),
      authorizationUrl: updated?.authorizationUrl ?? null,
      loginId: login.id,
      authorized: false,
    };
  } catch (error) {
    if (login) await failOAuthLogin(login.id, errorMessage(error), paths);
    return {
      ok: false,
      action: 'mcp_login_start',
      changed: false,
      message: `Failed to start MCP OAuth login for "${input.id}": ${errorMessage(error)}`,
      ...(login
        ? { login: await readPublicMcpOAuthLogin(login.id, paths) }
        : {}),
    };
  }
}

export async function completeMcpOAuthCallback(
  input: { state?: string | null; code?: string | null; error?: string | null },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldOAuthLogins(paths);
  if (!input.state) {
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: false,
      message: 'OAuth callback did not include a state parameter.',
    };
  }

  const login = await readMcpOAuthLoginByState(input.state, paths);
  if (!login) {
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: false,
      message: 'OAuth callback state was not recognized.',
    };
  }

  if (login.status === 'expired') {
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: false,
      message: `MCP OAuth login "${login.id}" has expired.`,
      login: publicMcpOAuthLogin(login),
    };
  }

  if (login.status !== 'pending' && login.status !== 'redirect') {
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: false,
      message: `MCP OAuth login "${login.id}" is already ${login.status}.`,
      login: publicMcpOAuthLogin(login),
    };
  }

  if (input.error) {
    await failOAuthLogin(login.id, input.error, paths);
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message: `MCP OAuth login failed: ${input.error}`,
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  }

  if (!input.code) {
    await failOAuthLogin(login.id, 'Missing authorization code.', paths);
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message: 'OAuth callback did not include an authorization code.',
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  }

  let server: McpServerConfig;
  try {
    ({ server } = await requireOAuthServer(login.serverId, paths));
  } catch (error) {
    await failOAuthLogin(login.id, errorMessage(error), paths);
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message: `Failed to finish MCP OAuth login: ${errorMessage(error)}`,
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  }

  if (login.serverIdentity !== oauthServerIdentity(server)) {
    await failOAuthLogin(
      login.id,
      'MCP OAuth server identity changed before callback completion.',
      paths,
    );
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message:
        'MCP OAuth server identity changed before callback completion. Start login again.',
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  }

  const provider = new NeondeckMcpOAuthProvider({
    paths,
    serverId: login.serverId,
    server,
    redirectUrl: login.redirectUrl,
    state: login.state,
  });

  try {
    await auth(provider, {
      serverUrl: server.url,
      authorizationCode: input.code,
    });
    if (!(await markOAuthLoginAuthorized(login.id, paths))) {
      const current = await readMcpOAuthLogin(login.id, paths);
      if (current?.status !== 'authorized') {
        clearTokenState(paths, login.serverId);
      }
      return inactiveOAuthLoginResult(login.id, paths);
    }
    return {
      ok: true,
      action: 'mcp_login_callback',
      changed: true,
      message: `Authorized MCP server "${login.serverId}".`,
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  } catch (error) {
    await failOAuthLogin(login.id, errorMessage(error), paths);
    return {
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message: `Failed to finish MCP OAuth login: ${errorMessage(error)}`,
      login: await readPublicMcpOAuthLogin(login.id, paths),
    };
  }
}

export async function logoutMcpOAuthServer(
  input: { id: string; confirm?: boolean },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  if (!input.confirm) {
    return {
      ok: false,
      action: 'mcp_logout',
      changed: false,
      message: `Logging out MCP server "${input.id}" requires confirm=true.`,
      requires: ['confirm'],
    };
  }

  const database = openDb(paths.neondeckDatabase);
  let changed = false;
  try {
    const result = database
      .prepare('DELETE FROM mcp_oauth_tokens WHERE server_id = ?;')
      .run(input.id);
    changed = result.changes > 0;
    database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET status = 'expired',
            code_verifier = NULL,
            updated_at = ?
        WHERE server_id = ?
          AND status IN ('pending', 'redirect');
      `,
      )
      .run(new Date().toISOString(), input.id);
  } finally {
    database.close();
  }
  if (changed) await expireMcpServerApprovals(input.id, paths);
  return {
    ok: true,
    action: 'mcp_logout',
    changed,
    message: changed
      ? `Removed OAuth tokens for MCP server "${input.id}".`
      : `MCP server "${input.id}" did not have stored OAuth tokens.`,
  };
}

export async function readMcpOAuthStatus(
  serverId: string,
  paths = runtimePaths(),
): Promise<McpOAuthStatus> {
  await ensureRuntimeHome(paths);
  const state = readTokenState(paths, serverId);
  const config = await readMcpConfig(paths).catch(() => null);
  const server = config?.servers[serverId];
  const identityMatches =
    server?.transport === 'http' && server.auth?.kind === 'oauth'
      ? state.serverIdentity === oauthServerIdentity(server)
      : false;
  return {
    authorized:
      identityMatches &&
      Boolean(state.refreshToken || usableAccessToken(state)),
    expiresAt: state.expiresAt,
    scopes: state.scopes,
    updatedAt: state.updatedAt,
  };
}

export async function hasMcpOAuthTokens(
  serverId: string,
  paths = runtimePaths(),
) {
  const status = await readMcpOAuthStatus(serverId, paths);
  return status.authorized;
}

export async function readMcpOAuthLogin(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  expireOldOAuthLogins(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM mcp_oauth_logins WHERE id = ?;')
      .get(id) as McpOAuthLoginRow | undefined;
    return row ? readLoginRow(row) : null;
  } finally {
    database.close();
  }
}

export async function readPublicMcpOAuthLogin(
  id: string,
  paths = runtimePaths(),
) {
  return publicMcpOAuthLogin(await readMcpOAuthLogin(id, paths));
}

export async function readMcpOAuthLoginByState(
  state: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldOAuthLogins(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM mcp_oauth_logins WHERE state = ?;')
      .get(state) as McpOAuthLoginRow | undefined;
    return row ? readLoginRow(row) : null;
  } finally {
    database.close();
  }
}

export function publicMcpOAuthLogin(
  login: McpOAuthLoginRecord | null,
): PublicMcpOAuthLoginRecord | null {
  if (!login) return null;
  const {
    state: _state,
    serverIdentity: _serverIdentity,
    ...safeLogin
  } = login;
  return safeLogin;
}

async function inactiveOAuthLoginResult(id: string, paths: RuntimePaths) {
  const login = await readPublicMcpOAuthLogin(id, paths);
  return {
    ok: false,
    action: 'mcp_login_callback',
    changed: false,
    message: login
      ? `MCP OAuth login "${id}" is already ${login.status}.`
      : `MCP OAuth login "${id}" was not found.`,
    ...(login ? { login } : { requires: ['id'] }),
  };
}

export function createMcpOAuthProvider(input: {
  paths: RuntimePaths;
  serverId: string;
  server: McpServerConfig;
  redirectUrl?: string;
  state?: string;
}) {
  return new NeondeckMcpOAuthProvider({
    ...input,
    redirectUrl: input.redirectUrl ?? defaultCallbackUrl,
    state: input.state ?? randomUUID(),
  });
}

class NeondeckMcpOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly input: {
      paths: RuntimePaths;
      serverId: string;
      server: McpServerConfig;
      redirectUrl: string;
      state: string;
    },
  ) {}

  get redirectUrl() {
    return this.input.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.input.redirectUrl],
      client_name: 'Neondeck',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  state() {
    return this.input.state;
  }

  clientInformation() {
    const configured = configuredClientInformation(this.input.server);
    if (configured) return configured;
    return this.currentTokenState().clientInformation ?? undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    if (configuredClientInformation(this.input.server)) return;
    writeTokenState(this.input.paths, this.input.serverId, {
      serverIdentity: oauthServerIdentity(this.input.server),
      clientInformation,
    });
  }

  tokens() {
    const state = this.currentTokenState();
    if (!state.accessToken || !state.tokenType) return undefined;
    return {
      access_token: state.accessToken,
      token_type: state.tokenType,
      ...(state.refreshToken ? { refresh_token: state.refreshToken } : {}),
      ...(state.idToken ? { id_token: state.idToken } : {}),
      ...(state.expiresAt
        ? { expires_in: expiresInSeconds(state.expiresAt) }
        : {}),
      ...(state.scopes.length > 0 ? { scope: state.scopes.join(' ') } : {}),
    } satisfies OAuthTokens;
  }

  saveTokens(tokens: OAuthTokens) {
    writeTokenState(this.input.paths, this.input.serverId, {
      serverIdentity: oauthServerIdentity(this.input.server),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenType: tokens.token_type,
      idToken: tokens.id_token ?? null,
      expiresAt:
        tokens.expires_in !== undefined
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
    });
    expireMcpServerApprovalsSync(this.input.serverId, this.input.paths);
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    await updateOAuthLoginAuthorizationUrl(
      this.input.state,
      authorizationUrl.toString(),
      this.input.paths,
    );
  }

  saveCodeVerifier(codeVerifier: string) {
    if (
      writeLoginStateByState(this.input.paths, this.input.state, {
        codeVerifier,
      })
    ) {
      return;
    }
    writeTokenState(this.input.paths, this.input.serverId, {
      serverIdentity: oauthServerIdentity(this.input.server),
      codeVerifier,
    });
  }

  codeVerifier() {
    const verifier =
      readLoginStateByState(this.input.paths, this.input.state)?.codeVerifier ??
      this.currentTokenState().codeVerifier;
    if (!verifier) {
      throw new Error('Missing MCP OAuth code verifier for login callback.');
    }
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    if (
      writeLoginStateByState(this.input.paths, this.input.state, {
        discoveryState: state,
      })
    ) {
      return;
    }
    writeTokenState(this.input.paths, this.input.serverId, {
      serverIdentity: oauthServerIdentity(this.input.server),
      discoveryState: state,
    });
  }

  discoveryState() {
    const loginState = readLoginStateByState(
      this.input.paths,
      this.input.state,
    );
    if (loginState) return loginState.discoveryState ?? undefined;
    return this.currentTokenState().discoveryState ?? undefined;
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    if (scope === 'all') {
      clearTokenState(this.input.paths, this.input.serverId);
      expireMcpServerApprovalsSync(this.input.serverId, this.input.paths);
      return;
    }
    const patch: Partial<TokenState> = {};
    if (scope === 'client') patch.clientInformation = null;
    if (scope === 'tokens') {
      patch.accessToken = null;
      patch.refreshToken = null;
      patch.tokenType = null;
      patch.idToken = null;
      patch.expiresAt = null;
      patch.scopes = [];
    }
    if (scope === 'verifier') patch.codeVerifier = null;
    if (scope === 'discovery') patch.discoveryState = null;
    writeTokenState(this.input.paths, this.input.serverId, patch);
    if (scope === 'tokens') {
      expireMcpServerApprovalsSync(this.input.serverId, this.input.paths);
    }
  }

  private currentTokenState() {
    const state = readTokenState(this.input.paths, this.input.serverId);
    return state.serverIdentity === oauthServerIdentity(this.input.server)
      ? state
      : emptyTokenState();
  }
}

async function requireOAuthServer(serverId: string, paths: RuntimePaths) {
  const config = await readMcpConfig(paths);
  const server = config.servers[serverId];
  if (!server) {
    throw new Error(`MCP server "${serverId}" was not found.`);
  }
  if (server.transport !== 'http' || server.auth?.kind !== 'oauth') {
    throw new Error(`MCP server "${serverId}" is not configured for OAuth.`);
  }
  return { config, server };
}

function configuredClientInformation(server: McpServerConfig) {
  if (server.transport !== 'http' || server.auth?.kind !== 'oauth') {
    return undefined;
  }
  const clientId = server.auth.clientId;
  if (!clientId) return undefined;
  const secretRef = server.auth.clientSecret;
  const secret = secretRef ? process.env[secretRef.env] : undefined;
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret } : {}),
  } satisfies OAuthClientInformationMixed;
}

function oauthServerIdentity(server: McpServerConfig) {
  if (server.transport !== 'http' || server.auth?.kind !== 'oauth') {
    return 'not-oauth';
  }
  return JSON.stringify({
    url: server.url,
    clientId: server.auth.clientId ?? null,
    clientSecretEnv: server.auth.clientSecret?.env ?? null,
  });
}

async function createOAuthLogin(
  serverId: string,
  redirectUrl: string,
  serverIdentity: string,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + loginTtlMs).toISOString();
  const id = randomUUID();
  const state = randomUUID();
  try {
    database
      .prepare(
        `
        INSERT INTO mcp_oauth_logins (
          id,
          server_id,
          server_identity,
          state,
          status,
          redirect_url,
          authorization_url,
          discovery_state_json,
          code_verifier,
          error,
          created_at,
          expires_at,
          completed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?);
      `,
      )
      .run(
        id,
        serverId,
        serverIdentity,
        state,
        redirectUrl,
        createdAt,
        expiresAt,
        createdAt,
      );
  } finally {
    database.close();
  }
  const login = await readMcpOAuthLogin(id, paths);
  if (!login) throw new Error('Failed to create MCP OAuth login.');
  return login;
}

async function updateOAuthLoginAuthorizationUrl(
  state: string,
  authorizationUrl: string,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET status = 'redirect',
            authorization_url = ?,
            updated_at = ?
        WHERE state = ?
          AND status = 'pending';
      `,
      )
      .run(authorizationUrl, now, state);
  } finally {
    database.close();
  }
}

type LoginStatePatch = {
  codeVerifier?: string | null;
  discoveryState?: OAuthDiscoveryState | null;
};

function writeLoginStateByState(
  paths: RuntimePaths,
  state: string,
  patch: LoginStatePatch,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const fields: string[] = [];
    const values: Array<string | null> = [];
    if ('codeVerifier' in patch) {
      fields.push('code_verifier = ?');
      values.push(patch.codeVerifier ?? null);
    }
    if ('discoveryState' in patch) {
      fields.push('discovery_state_json = ?');
      values.push(
        patch.discoveryState ? JSON.stringify(patch.discoveryState) : null,
      );
    }
    if (fields.length === 0) return false;
    values.push(new Date().toISOString(), state);
    const result = database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET ${fields.join(', ')},
            updated_at = ?
        WHERE state = ?
          AND status IN ('pending', 'redirect');
      `,
      )
      .run(...values);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

function readLoginStateByState(paths: RuntimePaths, state: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT code_verifier, discovery_state_json
        FROM mcp_oauth_logins
        WHERE state = ?;
      `,
      )
      .get(state) as McpOAuthLoginStateRow | undefined;
    if (!row) return null;
    return {
      codeVerifier: row.code_verifier,
      discoveryState: parseJson<OAuthDiscoveryState>(row.discovery_state_json),
    };
  } finally {
    database.close();
  }
}

async function markOAuthLoginAuthorized(id: string, paths: RuntimePaths) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const result = database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET status = 'authorized',
            code_verifier = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'redirect');
      `,
      )
      .run(now, now, id);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

async function failOAuthLogin(
  id: string,
  message: string,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const result = database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET status = 'failed',
            error = ?,
            code_verifier = NULL,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('pending', 'redirect');
      `,
      )
      .run(message, now, now, id);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

function expireOldOAuthLogins(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_oauth_logins
        SET status = 'expired',
            code_verifier = NULL,
            updated_at = ?
        WHERE status IN ('pending', 'redirect')
          AND expires_at <= ?;
      `,
      )
      .run(now, now);
  } finally {
    database.close();
  }
}

function readTokenState(paths: RuntimePaths, serverId: string): TokenState {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM mcp_oauth_tokens WHERE server_id = ?;')
      .get(serverId) as McpOAuthTokenRow | undefined;
    if (!row) return emptyTokenState();
    return {
      serverIdentity: row.server_identity,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      tokenType: row.token_type,
      idToken: row.id_token,
      expiresAt: row.expires_at,
      scopes: parseStringArray(row.scopes_json),
      clientInformation: parseJson(row.client_information_json),
      discoveryState: parseJson(row.discovery_state_json),
      codeVerifier: row.code_verifier,
      updatedAt: row.updated_at,
    };
  } finally {
    database.close();
  }
}

function writeTokenState(
  paths: RuntimePaths,
  serverId: string,
  patch: Partial<TokenState>,
) {
  const current = readTokenState(paths, serverId);
  const identityChanged =
    patch.serverIdentity !== undefined &&
    patch.serverIdentity !== current.serverIdentity;
  const next = { ...(identityChanged ? emptyTokenState() : current), ...patch };
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO mcp_oauth_tokens (
          server_id,
          server_identity,
          access_token,
          refresh_token,
          token_type,
          id_token,
          expires_at,
          scopes_json,
          client_information_json,
          discovery_state_json,
          code_verifier,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          server_identity = excluded.server_identity,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          token_type = excluded.token_type,
          id_token = excluded.id_token,
          expires_at = excluded.expires_at,
          scopes_json = excluded.scopes_json,
          client_information_json = excluded.client_information_json,
          discovery_state_json = excluded.discovery_state_json,
          code_verifier = excluded.code_verifier,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        serverId,
        next.serverIdentity,
        next.accessToken,
        next.refreshToken,
        next.tokenType,
        next.idToken,
        next.expiresAt,
        JSON.stringify(next.scopes),
        next.clientInformation ? JSON.stringify(next.clientInformation) : null,
        next.discoveryState ? JSON.stringify(next.discoveryState) : null,
        next.codeVerifier,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

function clearTokenState(paths: RuntimePaths, serverId: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM mcp_oauth_tokens WHERE server_id = ?;')
      .run(serverId);
  } finally {
    database.close();
  }
}

function emptyTokenState(): TokenState {
  return {
    serverIdentity: null,
    accessToken: null,
    refreshToken: null,
    tokenType: null,
    idToken: null,
    expiresAt: null,
    scopes: [],
    clientInformation: null,
    discoveryState: null,
    codeVerifier: null,
    updatedAt: null,
  };
}

function usableAccessToken(state: TokenState) {
  if (!state.accessToken) return false;
  if (!state.expiresAt) return true;
  return Date.parse(state.expiresAt) > Date.now();
}

type McpOAuthTokenRow = {
  server_identity: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  id_token: string | null;
  expires_at: string | null;
  scopes_json: string | null;
  client_information_json: string | null;
  discovery_state_json: string | null;
  code_verifier: string | null;
  updated_at: string;
};

type McpOAuthLoginRow = {
  id: string;
  server_id: string;
  server_identity: string | null;
  state: string;
  status: McpOAuthLoginStatus;
  redirect_url: string;
  authorization_url: string | null;
  discovery_state_json: string | null;
  code_verifier: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  updated_at: string;
};

type McpOAuthLoginStateRow = {
  code_verifier: string | null;
  discovery_state_json: string | null;
};

function readLoginRow(row: McpOAuthLoginRow): McpOAuthLoginRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    serverIdentity: row.server_identity,
    state: row.state,
    status: row.status,
    redirectUrl: row.redirect_url,
    authorizationUrl: row.authorization_url,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: string | null) {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseJson<T = unknown>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function expiresInSeconds(expiresAt: string) {
  return Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
}

function isAllowedOAuthRedirectUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === 'http:' &&
    url.pathname === '/api/mcp/oauth/callback' &&
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
