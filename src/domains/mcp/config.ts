import { openDb } from '../../lib/sqlite.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as v from 'valibot';
import {
  configEventFromChange,
  publishConfigEvent,
} from '../../modules/config/events';
import {
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import {
  defaultMcpConfig,
  mcpConfigSchema,
  mcpServerAddInputSchema,
  mcpServerConfigSchema,
  mcpServerEnabled,
  mcpServerIdSchema,
  mcpServerRemoveInputSchema,
  mcpServerUpdateInputSchema,
  parseMcpConfig,
  type McpConfig,
  type McpServerConfig,
} from './schemas';
import { expireMcpServerApprovals } from './store';

export type McpConfigActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  home: string;
  files: string[];
  data?: unknown;
  errors?: string[];
  requires?: string[];
};

export async function readMcpConfig(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readRuntimeJson(paths.mcp, parseMcpConfig);
}

export async function listMcpServers(paths = runtimePaths()) {
  const config = await readMcpConfig(paths);
  return {
    ok: true,
    action: 'mcp_servers_list',
    changed: false,
    message: `Read ${Object.keys(config.servers).length} MCP server config entries.`,
    servers: Object.entries(config.servers).map(([id, server]) => ({
      id,
      ...server,
      enabled: mcpServerEnabled(server),
    })),
  };
}

export async function addMcpServer(rawInput: unknown, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(mcpServerAddInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'mcp_server_add',
      paths,
      `Invalid MCP server add input: ${v.summarize(parsed.issues)}`,
      ['id', 'server'],
    );
  }

  const config = await readMcpConfig(paths);
  if (config.servers[parsed.output.id]) {
    return failedResult(
      'mcp_server_add',
      paths,
      `MCP server "${parsed.output.id}" already exists.`,
      ['id'],
    );
  }

  const next = parseConfig(
    {
      servers: {
        ...config.servers,
        [parsed.output.id]: parsed.output.server,
      },
    },
    paths,
  );
  await writeChangedConfig(
    paths,
    'mcp_server_add',
    parsed.output.id,
    config,
    next,
  );
  return okResult('mcp_server_add', true, paths, {
    message: `Added MCP server "${parsed.output.id}".`,
    data: { server: { id: parsed.output.id, ...parsed.output.server } },
  });
}

export async function updateMcpServer(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(mcpServerUpdateInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'mcp_server_update',
      paths,
      `Invalid MCP server update input: ${v.summarize(parsed.issues)}`,
      ['id', 'server'],
    );
  }

  const config = await readMcpConfig(paths);
  const existing = config.servers[parsed.output.id];
  if (!existing) {
    return failedResult(
      'mcp_server_update',
      paths,
      `MCP server "${parsed.output.id}" was not found.`,
      ['id'],
    );
  }

  const mergedRaw: Record<string, unknown> = {
    ...existing,
    ...parsed.output.server,
  };
  replaceOptionalField(mergedRaw, parsed.output.server, 'auth');
  replaceOptionalField(mergedRaw, parsed.output.server, 'tools');

  let merged: McpServerConfig;
  let next: McpConfig;
  try {
    merged = parseServerConfig(mergedRaw, paths);
    next = parseConfig(
      {
        servers: {
          ...config.servers,
          [parsed.output.id]: merged,
        },
      },
      paths,
    );
  } catch (error) {
    return failedResult(
      'mcp_server_update',
      paths,
      `Invalid MCP server update patch: ${errorMessage(error)}`,
      ['server'],
    );
  }
  const changed =
    JSON.stringify(config.servers[parsed.output.id]) !== JSON.stringify(merged);
  if (changed) {
    const clearOAuth = mcpOAuthIdentityChanged(existing, merged);
    const expireApprovals = mcpApprovalScopeChanged(existing, merged);
    await writeChangedConfig(
      paths,
      'mcp_server_update',
      parsed.output.id,
      config,
      next,
    );
    if (expireApprovals) {
      await expireMcpServerApprovals(parsed.output.id, paths);
    }
    if (clearOAuth) {
      deleteMcpOAuthState(paths, parsed.output.id);
    }
  }
  return okResult('mcp_server_update', changed, paths, {
    message: changed
      ? `Updated MCP server "${parsed.output.id}".`
      : `MCP server "${parsed.output.id}" already matched the requested config.`,
    data: { server: { id: parsed.output.id, ...merged } },
  });
}

export async function setMcpServerEnabled(
  rawInput: unknown,
  enabled: boolean,
  paths = runtimePaths(),
) {
  const parsed = v.safeParse(v.object({ id: mcpServerIdSchema }), rawInput);
  if (!parsed.success) {
    return failedResult(
      enabled ? 'mcp_server_enable' : 'mcp_server_disable',
      paths,
      `Invalid MCP server id: ${v.summarize(parsed.issues)}`,
      ['id'],
    );
  }
  return updateMcpServer({ id: parsed.output.id, server: { enabled } }, paths);
}

export async function removeMcpServer(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(mcpServerRemoveInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'mcp_server_remove',
      paths,
      `Invalid MCP server remove input: ${v.summarize(parsed.issues)}`,
      ['id'],
    );
  }

  if (!parsed.output.confirm) {
    return failedResult(
      'mcp_server_remove',
      paths,
      `Removing MCP server "${parsed.output.id}" requires confirm=true.`,
      ['confirm'],
    );
  }

  const config = await readMcpConfig(paths);
  if (!config.servers[parsed.output.id]) {
    return failedResult(
      'mcp_server_remove',
      paths,
      `MCP server "${parsed.output.id}" was not found.`,
      ['id'],
    );
  }

  const servers = { ...config.servers };
  delete servers[parsed.output.id];
  const next = parseConfig({ servers }, paths);
  await writeChangedConfig(
    paths,
    'mcp_server_remove',
    parsed.output.id,
    config,
    next,
  );
  deleteMcpServerState(paths, parsed.output.id);
  return okResult('mcp_server_remove', true, paths, {
    message: `Removed MCP server "${parsed.output.id}".`,
  });
}

export async function validateMcpConfig(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  try {
    const config = await readMcpConfig(paths);
    return okResult('mcp_config_validate', false, paths, {
      message: 'Validated MCP config.',
      data: config,
    });
  } catch (error) {
    return failedResult('mcp_config_validate', paths, errorMessage(error), []);
  }
}

function parseConfig(value: unknown, paths: RuntimePaths): McpConfig {
  const result = v.safeParse(mcpConfigSchema, value);
  if (!result.success) {
    throw new Error(`${paths.mcp}: ${v.summarize(result.issues)}`);
  }
  return result.output;
}

function parseServerConfig(
  value: unknown,
  paths: RuntimePaths,
): McpServerConfig {
  const result = v.safeParse(mcpServerConfigSchema, value);
  if (!result.success) {
    throw new Error(`${paths.mcp}: ${v.summarize(result.issues)}`);
  }
  return result.output;
}

async function writeChangedConfig(
  paths: RuntimePaths,
  action: string,
  target: string,
  before: McpConfig,
  after: McpConfig,
) {
  await writeJson(paths.mcp, after);
  recordMcpConfigChange(paths, {
    action,
    target,
    before,
    after,
  });
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

function recordMcpConfigChange(
  paths: RuntimePaths,
  change: {
    action: string;
    target: string;
    before: McpConfig;
    after: McpConfig;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const result = database
      .prepare(
        `
        INSERT INTO config_history (
          action,
          file,
          target,
          before_json,
          after_json,
          changed_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        change.action,
        paths.mcp,
        change.target,
        JSON.stringify(change.before),
        JSON.stringify(change.after),
        now,
      );
    publishConfigEvent(
      configEventFromChange(paths, {
        id: result.lastInsertRowid,
        action: change.action,
        changed: true,
        files: [paths.mcp],
        target: change.target,
        changedAt: now,
      }),
    );
  } finally {
    database.close();
  }
}

function deleteMcpServerState(paths: RuntimePaths, serverId: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM mcp_tool_catalog WHERE server_id = ?;')
      .run(serverId);
    database
      .prepare('DELETE FROM mcp_tool_approvals WHERE server_id = ?;')
      .run(serverId);
    database
      .prepare('DELETE FROM mcp_oauth_tokens WHERE server_id = ?;')
      .run(serverId);
    database
      .prepare('DELETE FROM mcp_oauth_logins WHERE server_id = ?;')
      .run(serverId);
  } finally {
    database.close();
  }
}

function deleteMcpOAuthState(paths: RuntimePaths, serverId: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM mcp_oauth_tokens WHERE server_id = ?;')
      .run(serverId);
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
      .run(new Date().toISOString(), serverId);
  } finally {
    database.close();
  }
}

function mcpApprovalScopeChanged(
  before: McpServerConfig,
  after: McpServerConfig,
) {
  if (before.transport !== after.transport) return true;
  if (jsonChanged(before.tools, after.tools)) return true;
  if (before.transport === 'http' && after.transport === 'http') {
    return before.url !== after.url || jsonChanged(before.auth, after.auth);
  }
  if (before.transport === 'stdio' && after.transport === 'stdio') {
    return (
      before.command !== after.command ||
      jsonChanged(before.args, after.args) ||
      before.cwd !== after.cwd ||
      jsonChanged(before.env, after.env)
    );
  }
  return false;
}

function mcpOAuthIdentityChanged(
  before: McpServerConfig,
  after: McpServerConfig,
) {
  if (before.transport !== 'http' || before.auth?.kind !== 'oauth') {
    return false;
  }
  if (after.transport !== 'http' || after.auth?.kind !== 'oauth') {
    return true;
  }
  return (
    before.url !== after.url ||
    before.auth.clientId !== after.auth.clientId ||
    before.auth.clientSecret?.env !== after.auth.clientSecret?.env
  );
}

function jsonChanged(before: unknown, after: unknown) {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

function replaceOptionalField(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  key: string,
) {
  if (!Object.hasOwn(patch, key)) return;
  const value = patch[key];
  if (value === null || value === undefined) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function okResult(
  action: string,
  changed: boolean,
  paths: RuntimePaths,
  extra: { message: string; data?: unknown },
): McpConfigActionResult {
  return {
    ok: true,
    action,
    changed,
    message: extra.message,
    home: paths.home,
    files: [paths.mcp],
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  };
}

function failedResult(
  action: string,
  paths: RuntimePaths,
  message: string,
  requires: string[],
): McpConfigActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    home: paths.home,
    files: [paths.mcp],
    ...(requires.length > 0 ? { requires } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function readRawMcpConfigFile(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  return readFile(paths.mcp, 'utf8');
}

export { defaultMcpConfig };
