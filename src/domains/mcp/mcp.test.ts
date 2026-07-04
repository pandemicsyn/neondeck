import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addMcpServer,
  getMcpRegistry,
  listMcpApprovals,
  listMcpAudit,
  readMcpConfig,
  resolveMcpApprovalWithPaths,
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
});

async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'neondeck-mcp-'));
  tempRoots.push(root);
  return root;
}
