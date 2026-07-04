import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addMcpServer,
  completeMcpOAuthCallback,
  consumeUsableMcpApproval,
  createMcpApprovalRequest,
  getMcpRegistry,
  listMcpApprovals,
  listMcpAudit,
  readMcpOAuthStatus,
  readMcpConfig,
  resolveMcpApprovalWithPaths,
  startMcpOAuthLogin,
  updateMcpServer,
} from './index';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (path) => {
      await getMcpRegistry(runtimePaths(path)).stop();
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe('MCP support', () => {
  it('bootstraps and validates strict mcp.json config', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);

    await ensureRuntimeHome(paths);
    await expect(readMcpConfig(paths)).resolves.toEqual({ servers: {} });
    await expect(readFile(paths.mcp, 'utf8')).resolves.toContain('"servers"');

    await writeFile(
      paths.mcp,
      JSON.stringify({
        servers: {
          linear: {
            transport: 'http',
            url: 'https://mcp.example.test/mcp',
            auth: {
              kind: 'header',
              headers: {
                Authorization: 'raw-token',
              },
            },
          },
        },
      }),
    );

    await expect(readMcpConfig(paths)).rejects.toThrow(
      /Invalid key|Invalid type|env/i,
    );
  });

  it('gates stdio MCP tool calls with hash-bound approvals', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    const fixture = fileURLToPath(
      new URL('./fixtures/stdio-server.mjs', import.meta.url),
    );
    await expect(
      addMcpServer(
        {
          id: 'fixture',
          server: {
            transport: 'stdio',
            command: process.execPath,
            args: [fixture],
            tools: {
              deny: ['danger'],
            },
          },
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });

    const registry = getMcpRegistry(paths);
    await registry.refresh('fixture');
    const echo = registry
      .toolsSync()
      .find((tool) => tool.name === 'mcp__fixture__echo');
    expect(echo).toBeTruthy();

    const first = await echo!.run({
      input: { text: 'hello' },
    } as never);
    expect(first).toMatchObject({
      ok: false,
      status: 'approval-required',
      server: 'fixture',
      tool: 'echo',
    });

    const approvals = await listMcpApprovals(paths);
    expect(approvals).toHaveLength(1);
    await expect(
      resolveMcpApprovalWithPaths(
        {
          id: approvals[0].id,
          decision: 'approve',
          approverSurface: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });

    const second = await echo!.run({
      input: { text: 'hello' },
    } as never);
    expect(second).toMatchObject({
      ok: true,
      status: 'ok',
      server: 'fixture',
      tool: 'echo',
      untrusted: true,
    });
    expect(JSON.stringify(second)).toContain('echo:hello');

    const denied = registry
      .toolsSync()
      .find((tool) => tool.name === 'mcp__fixture__danger');
    const deniedResult = await denied!.run({
      input: { text: 'stop' },
    } as never);
    expect(deniedResult).toMatchObject({
      ok: false,
      status: 'denied',
    });

    const audit = await listMcpAudit(paths, { serverId: 'fixture' });
    expect(audit.map((row) => row.decision)).toEqual([
      'deny',
      'approved',
      'ask',
    ]);
  });

  it('keeps existing MCP tools usable when reading status and tool catalogs', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const fixture = fixturePath();

    await addMcpServer(
      {
        id: 'fixture',
        server: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixture],
          tools: {
            autoApprove: ['echo'],
          },
        },
      },
      paths,
    );

    const registry = getMcpRegistry(paths);
    await registry.refresh('fixture');
    const echo = registry
      .toolsSync()
      .find((tool) => tool.name === 'mcp__fixture__echo');
    expect(echo).toBeTruthy();

    await expect(registry.status()).resolves.toHaveLength(1);
    await expect(registry.listTools('fixture')).resolves.toHaveLength(2);
    await expect(
      echo!.run({ input: { text: 'still-connected' } } as never),
    ).resolves.toMatchObject({
      ok: true,
      status: 'ok',
      content: expect.stringContaining('echo:still-connected'),
    });
  });

  it('does not publish stale MCP tools from an in-flight refresh', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const previous = process.env.NEONDECK_MCP_START_DELAY_MS;
    process.env.NEONDECK_MCP_START_DELAY_MS = '150';
    try {
      await addMcpServer(
        {
          id: 'fixture',
          server: {
            transport: 'stdio',
            command: process.execPath,
            args: [fixturePath()],
            env: {
              NEONDECK_MCP_START_DELAY_MS: {
                env: 'NEONDECK_MCP_START_DELAY_MS',
              },
            },
          },
        },
        paths,
      );

      const registry = getMcpRegistry(paths);
      const firstRefresh = registry.refresh('fixture');
      await updateMcpServer(
        {
          id: 'fixture',
          server: {
            enabled: false,
          },
        },
        paths,
      );
      const secondRefresh = registry.refresh('fixture');
      await Promise.all([firstRefresh, secondRefresh]);

      await expect(registry.status()).resolves.toMatchObject([
        {
          id: 'fixture',
          enabled: false,
          status: 'disabled',
          toolCount: 0,
        },
      ]);
      expect(
        registry.toolsSync().some((tool) => tool.name === 'mcp__fixture__echo'),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.NEONDECK_MCP_START_DELAY_MS;
      } else {
        process.env.NEONDECK_MCP_START_DELAY_MS = previous;
      }
    }
  });

  it('consumes approved MCP tool calls atomically', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const request = await createMcpApprovalRequest(
      {
        serverId: 'fixture',
        toolName: 'echo',
        adaptedName: 'mcp__fixture__echo',
        argumentsHash: 'abc123',
        argumentsPreview: '{"text":"hello"}',
      },
      paths,
    );
    await resolveMcpApprovalWithPaths(
      {
        id: request!.id,
        decision: 'approve',
        approverSurface: 'test',
      },
      paths,
    );

    await expect(
      consumeUsableMcpApproval(
        {
          serverId: 'fixture',
          toolName: 'echo',
          adaptedName: 'mcp__fixture__echo',
          argumentsHash: 'abc123',
        },
        paths,
      ),
    ).resolves.toMatchObject({ id: request!.id, status: 'used' });
    await expect(
      consumeUsableMcpApproval(
        {
          serverId: 'fixture',
          toolName: 'echo',
          adaptedName: 'mcp__fixture__echo',
          argumentsHash: 'abc123',
        },
        paths,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveMcpApprovalWithPaths(
        {
          id: request!.id,
          decision: 'deny',
          approverSurface: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      approval: { id: request!.id, status: 'used' },
    });
  });

  it('rejects invalid MCP approval decisions without resolving the request', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const request = await createMcpApprovalRequest(
      {
        serverId: 'fixture',
        toolName: 'echo',
        adaptedName: 'mcp__fixture__echo',
        argumentsHash: 'abc123',
        argumentsPreview: '{"text":"hello"}',
      },
      paths,
    );

    await expect(
      resolveMcpApprovalWithPaths(
        {
          id: request!.id,
          decision: 'typo',
          approverSurface: 'test',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['id', 'decision'],
    });
    await expect(listMcpApprovals(paths)).resolves.toMatchObject([
      {
        id: request!.id,
        status: 'pending',
      },
    ]);
  });

  it('rejects non-loopback MCP OAuth redirect URLs', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'remote',
        server: {
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
          auth: { kind: 'oauth' },
        },
      },
      paths,
    );

    await expect(
      startMcpOAuthLogin(
        {
          id: 'remote',
          redirectUrl: 'https://example.test/api/mcp/oauth/callback',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      action: 'mcp_login_start',
      requires: ['redirectUrl'],
    });
  });

  it('returns typed MCP OAuth login errors for non-oauth servers', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await expect(
      startMcpOAuthLogin({ id: 'missing' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'mcp_login_start',
      changed: false,
      message: expect.stringContaining('was not found'),
    });

    await addMcpServer(
      {
        id: 'plain',
        server: {
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
        },
      },
      paths,
    );
    await expect(
      startMcpOAuthLogin({ id: 'plain' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'mcp_login_start',
      changed: false,
      message: expect.stringContaining('not configured for OAuth'),
    });
  });

  it('clears stored MCP OAuth state when user-owned endpoint identity changes', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'remote',
        server: {
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
          auth: { kind: 'oauth' },
        },
      },
      paths,
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
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
          VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, ?);
        `,
        )
        .run(
          'remote',
          oauthServerIdentity('https://mcp.example.test/mcp'),
          'token-1',
          'Bearer',
          JSON.stringify(['read']),
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }

    await expect(readMcpOAuthStatus('remote', paths)).resolves.toMatchObject({
      authorized: true,
    });
    await updateMcpServer(
      {
        id: 'remote',
        server: {
          url: 'https://mcp2.example.test/mcp',
        },
      },
      paths,
    );
    await expect(readMcpOAuthStatus('remote', paths)).resolves.toMatchObject({
      authorized: false,
    });
  });

  it('does not authorize expired access-only MCP OAuth tokens', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'remote',
        server: {
          transport: 'http',
          url: 'https://mcp.example.test/mcp',
          auth: { kind: 'oauth' },
        },
      },
      paths,
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
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
          VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, ?);
        `,
        )
        .run(
          'remote',
          oauthServerIdentity('https://mcp.example.test/mcp'),
          'expired-token',
          'Bearer',
          new Date(Date.now() - 60_000).toISOString(),
          JSON.stringify(['read']),
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }

    await expect(readMcpOAuthStatus('remote', paths)).resolves.toMatchObject({
      authorized: false,
    });
  });

  it('rejects MCP OAuth callbacks when server identity changed since login start', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'remote',
        server: {
          transport: 'http',
          url: 'https://mcp2.example.test/mcp',
          auth: { kind: 'oauth' },
        },
      },
      paths,
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
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
          VALUES (?, ?, ?, ?, 'redirect', ?, ?, NULL, ?, NULL, ?, ?, NULL, ?);
        `,
        )
        .run(
          'login-1',
          'remote',
          oauthServerIdentity('https://mcp.example.test/mcp'),
          'state-1',
          'http://127.0.0.1:3583/api/mcp/oauth/callback',
          'https://auth.example.test/authorize',
          'verifier-1',
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }

    await expect(
      completeMcpOAuthCallback({ state: 'state-1', code: 'code-1' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'mcp_login_callback',
      changed: true,
      message: expect.stringContaining('identity changed'),
    });
  });

  it('does not rebind stale MCP OAuth tokens when identity-scoped metadata changes', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    const database = new DatabaseSync(paths.neondeckDatabase);
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
          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)
          ON CONFLICT(server_id) DO UPDATE SET
            server_identity = excluded.server_identity,
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            token_type = excluded.token_type,
            scopes_json = excluded.scopes_json,
            updated_at = excluded.updated_at;
        `,
        )
        .run(
          'remote',
          oauthServerIdentity('https://mcp.example.test/mcp'),
          'old-access-token',
          'old-refresh-token',
          'Bearer',
          JSON.stringify(['read']),
          new Date().toISOString(),
        );
    } finally {
      database.close();
    }

    const { createMcpOAuthProvider } = await import('./oauth');
    const provider = createMcpOAuthProvider({
      paths,
      serverId: 'remote',
      server: {
        transport: 'http',
        url: 'https://mcp2.example.test/mcp',
        auth: { kind: 'oauth' },
      },
      state: 'metadata-state',
    });
    provider.saveClientInformation({ client_id: 'client-2' });

    const after = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
    try {
      const row = after
        .prepare('SELECT * FROM mcp_oauth_tokens WHERE server_id = ?;')
        .get('remote') as Record<string, unknown>;
      expect(row.server_identity).toBe(
        oauthServerIdentity('https://mcp2.example.test/mcp'),
      );
      expect(row.access_token).toBeNull();
      expect(row.refresh_token).toBeNull();
      expect(row.token_type).toBeNull();
      expect(JSON.stringify(row.client_information_json)).toContain('client-2');
    } finally {
      after.close();
    }
  });

  it('bounds MCP structured content returned to the model', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'fixture',
        server: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixturePath()],
          tools: {
            autoApprove: ['echo'],
          },
        },
      },
      paths,
    );
    const registry = getMcpRegistry(paths);
    await registry.refresh('fixture');
    const echo = registry
      .toolsSync()
      .find((tool) => tool.name === 'mcp__fixture__echo');
    const result = await echo!.run({
      input: { text: 'x'.repeat(30_000) },
    } as never);

    expect(result).toMatchObject({
      ok: true,
      status: 'ok',
      structuredContent: {
        truncated: true,
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(35_000);
  });

  it('hydrates cached MCP tool placeholders after a restart when reconnect fails', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);

    await addMcpServer(
      {
        id: 'fixture',
        server: {
          transport: 'stdio',
          command: process.execPath,
          args: [fixturePath()],
          tools: {
            autoApprove: ['echo'],
          },
        },
      },
      paths,
    );
    const registry = getMcpRegistry(paths);
    await registry.refresh('fixture');
    await expect(registry.listTools('fixture')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adaptedName: 'mcp__fixture__echo' }),
      ]),
    );
    await registry.stop();
    await updateMcpServer(
      {
        id: 'fixture',
        server: {
          command: '/definitely/not/a/command',
        },
      },
      paths,
    );
    await registry.refresh('fixture');
    const echo = registry
      .toolsSync()
      .find((tool) => tool.name === 'mcp__fixture__echo');
    expect(echo).toBeTruthy();
    await expect(
      echo!.run({ input: { text: 'offline' } } as never),
    ).resolves.toMatchObject({
      ok: false,
      status: 'server-disconnected',
      server: 'fixture',
      tool: 'echo',
    });
  });

  it('rejects duplicate adapted MCP tool names', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const previous = process.env.NEONDECK_MCP_DUPLICATE_TOOLS;
    process.env.NEONDECK_MCP_DUPLICATE_TOOLS = '1';
    try {
      await addMcpServer(
        {
          id: 'fixture',
          server: {
            transport: 'stdio',
            command: process.execPath,
            args: [fixturePath()],
            env: {
              NEONDECK_MCP_DUPLICATE_TOOLS: {
                env: 'NEONDECK_MCP_DUPLICATE_TOOLS',
              },
            },
          },
        },
        paths,
      );

      const registry = getMcpRegistry(paths);
      await registry.refresh('fixture');
      await expect(registry.status()).resolves.toMatchObject([
        {
          id: 'fixture',
          status: 'error',
          message: expect.stringContaining('duplicate adapted tool name'),
        },
      ]);
    } finally {
      if (previous === undefined)
        delete process.env.NEONDECK_MCP_DUPLICATE_TOOLS;
      else process.env.NEONDECK_MCP_DUPLICATE_TOOLS = previous;
    }
  });

  it('marks missing MCP catalog tools unavailable after refresh', async () => {
    const home = await tempDir();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const previous = process.env.NEONDECK_MCP_ONLY_ECHO;
    try {
      delete process.env.NEONDECK_MCP_ONLY_ECHO;
      await addMcpServer(
        {
          id: 'fixture',
          server: {
            transport: 'stdio',
            command: process.execPath,
            args: [fixturePath()],
            env: {
              NEONDECK_MCP_ONLY_ECHO: { env: 'NEONDECK_MCP_ONLY_ECHO' },
            },
          },
        },
        paths,
      );

      const registry = getMcpRegistry(paths);
      await registry.refresh('fixture');
      await expect(registry.listTools('fixture')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'danger', status: 'available' }),
        ]),
      );

      process.env.NEONDECK_MCP_ONLY_ECHO = '1';
      await registry.refresh('fixture');
      await expect(registry.listTools('fixture')).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: 'danger',
            status: 'unavailable',
          }),
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.NEONDECK_MCP_ONLY_ECHO;
      else process.env.NEONDECK_MCP_ONLY_ECHO = previous;
    }
  });
});

function fixturePath() {
  return fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
}

function oauthServerIdentity(url: string) {
  return JSON.stringify({
    url,
    sse: false,
    clientId: null,
    clientSecretEnv: null,
  });
}

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-mcp-'));
  tempRoots.push(root);
  return root;
}
