import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addMcpServer,
  consumeUsableMcpApproval,
  createMcpApprovalRequest,
  getMcpRegistry,
  listMcpApprovals,
  listMcpAudit,
  readMcpConfig,
  resolveMcpApprovalWithPaths,
  startMcpOAuthLogin,
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

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-mcp-'));
  tempRoots.push(root);
  return root;
}
