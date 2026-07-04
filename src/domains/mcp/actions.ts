import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import {
  addMcpServer,
  readMcpConfig,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
} from './config';
import { logoutMcpOAuthServer, startMcpOAuthLogin } from './oauth';
import { getMcpRegistry } from './registry';
import {
  mcpActionResultSchema,
  mcpApprovalResolveInputSchema,
  mcpEmptyInputSchema,
  mcpLoginStartInputSchema,
  mcpLogoutInputSchema,
  mcpServerAddInputSchema,
  mcpServerIdInputSchema,
  mcpServerIdSchema,
  mcpServerRemoveInputSchema,
  mcpServerUpdateInputSchema,
} from './schemas';
import { resolveMcpApprovalWithPaths } from './store';
import { runtimePaths } from '../../runtime-home';

export const mcpServerAddAction = defineAction({
  name: 'neondeck_mcp_server_add',
  description:
    'Add one MCP server to mcp.json using strict config validation and environment-variable secret references.',
  input: mcpServerAddInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const guard = guardAgentMcpServerConfig(input.server, 'mcp_server_add');
    if (guard) return guard;
    const result = await addMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return result;
  },
});

export const mcpServerUpdateAction = defineAction({
  name: 'neondeck_mcp_server_update',
  description:
    'Update one configured MCP server in mcp.json using strict config validation.',
  input: mcpServerUpdateInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerUpdate(
      input.id,
      input.server,
      paths,
    );
    if (guard) return guard;
    const result = await updateMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return result;
  },
});

export const mcpServerRemoveAction = defineAction({
  name: 'neondeck_mcp_server_remove',
  description:
    'Remove one configured MCP server and its cached MCP state. Requires confirm=true.',
  input: mcpServerRemoveInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const result = await removeMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh();
    return result;
  },
});

export const mcpServerEnableAction = defineAction({
  name: 'neondeck_mcp_server_enable',
  description: 'Enable one configured MCP server and refresh its connection.',
  input: mcpServerIdInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerConnect(input.id, paths);
    if (guard) return guard;
    const result = await setMcpServerEnabled(input, true, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { ...result, action: 'mcp_server_enable' };
  },
});

export const mcpServerDisableAction = defineAction({
  name: 'neondeck_mcp_server_disable',
  description: 'Disable one configured MCP server and close its connection.',
  input: mcpServerIdInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const result = await setMcpServerEnabled(input, false, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { ...result, action: 'mcp_server_disable' };
  },
});

export const mcpApprovalResolveAction = defineAction({
  name: 'neondeck_mcp_approval_resolve',
  description:
    'Approve or deny one pending MCP tool-call approval. Requires confirm=true.',
  input: mcpApprovalResolveInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    if (!input.confirm) {
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: 'Resolving MCP approvals requires confirm=true.',
        requires: ['confirm'],
      };
    }
    return resolveMcpApprovalWithPaths(input, runtimePaths());
  },
});

export const mcpLoginStartAction = defineAction({
  name: 'neondeck_mcp_login_start',
  description:
    'Start OAuth login for one configured MCP server and return a user-facing authorization URL.',
  input: mcpLoginStartInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    return startMcpOAuthLogin(input, runtimePaths());
  },
});

export const mcpLogoutAction = defineAction({
  name: 'neondeck_mcp_logout',
  description:
    'Remove stored OAuth tokens for one MCP server. Requires confirm=true.',
  input: mcpLogoutInputSchema,
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const result = await logoutMcpOAuthServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return result;
  },
});

export const mcpRegistryRefreshAction = defineAction({
  name: 'neondeck_mcp_registry_refresh',
  description: 'Refresh MCP server connections and cached tool catalogs.',
  input: v.object({
    id: v.optional(mcpServerIdSchema),
  }),
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
    if (!input.id) {
      return {
        ok: false,
        action: 'mcp_registry_refresh',
        changed: false,
        message:
          'Model-callable MCP refresh requires a single safe HTTP/OAuth server id. Use the dashboard or CLI for full registry refresh.',
        requires: ['id'],
      };
    }
    const guard = await guardAgentMcpServerConnect(input.id, paths);
    if (guard) return { ...guard, action: 'mcp_registry_refresh' };
    await getMcpRegistry(paths).refresh(input.id);
    return {
      ok: true,
      action: 'mcp_registry_refresh',
      changed: false,
      message: input.id
        ? `Refreshed MCP server "${input.id}".`
        : 'Refreshed MCP registry.',
    };
  },
});

export const mcpStatusAction = defineAction({
  name: 'neondeck_mcp_status',
  description: 'Read MCP server connection status and tool counts.',
  input: mcpEmptyInputSchema,
  output: mcpActionResultSchema,
  async run() {
    const paths = runtimePaths();
    const servers = await getMcpRegistry(paths).status();
    return {
      ok: true,
      action: 'mcp_status',
      changed: false,
      message: `Read ${servers.length} MCP server statuses.`,
      servers,
    };
  },
});

export const neondeckMcpActions = [
  mcpServerAddAction,
  mcpServerUpdateAction,
  mcpServerRemoveAction,
  mcpServerEnableAction,
  mcpServerDisableAction,
  mcpLoginStartAction,
  mcpLogoutAction,
  mcpRegistryRefreshAction,
  mcpStatusAction,
];

function guardAgentMcpServerConfig(
  server: {
    transport: string;
    auth?: { kind?: string; clientSecret?: unknown };
    tools?: { autoApprove?: string[] };
  },
  action: string,
) {
  if (server.transport === 'stdio') {
    return blockedAgentMcpAction(
      action,
      'Adding or connecting stdio MCP servers is user-surface only because it can spawn host processes.',
    );
  }
  if (server.auth?.kind === 'header') {
    return blockedAgentMcpAction(
      action,
      'Header-authenticated MCP servers are user-surface only because they forward environment-backed secrets.',
    );
  }
  if (server.auth?.kind === 'oauth' && server.auth.clientSecret !== undefined) {
    return blockedAgentMcpAction(
      action,
      'OAuth MCP client-secret references are user-surface only because they forward environment-backed secrets.',
    );
  }
  if (server.tools?.autoApprove && server.tools.autoApprove.length > 0) {
    return blockedAgentMcpAction(
      action,
      'MCP tool auto-approval can only be configured from the dashboard, CLI, or direct config edit.',
    );
  }
  return null;
}

async function guardAgentMcpServerUpdate(
  id: string,
  patch: Record<string, unknown>,
  paths: ReturnType<typeof runtimePaths>,
) {
  const config = await readMcpConfig(paths);
  const existing = config.servers[id];
  if (!existing) return null;
  if (existing.transport === 'stdio') {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'Stdio MCP servers can only be updated from a user-owned surface because they can spawn host processes.',
    );
  }
  if (existing.transport === 'http' && existing.auth?.kind === 'header') {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'Header-authenticated MCP servers can only be updated from a user-owned surface.',
    );
  }
  if (hasUserOwnedMcpUpdateField(patch)) {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'Endpoint, transport, auth, stdio process, and MCP trust-policy changes must be made from a user-owned surface so existing approvals and auto-approval policy cannot be retargeted by the model.',
    );
  }
  return null;
}

function hasUserOwnedMcpUpdateField(patch: Record<string, unknown>) {
  return [
    'transport',
    'url',
    'sse',
    'auth',
    'tools',
    'command',
    'args',
    'cwd',
    'env',
  ].some((key) => Object.hasOwn(patch, key));
}

async function guardAgentMcpServerConnect(
  id: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const config = await readMcpConfig(paths);
  const server = config.servers[id];
  if (!server) return null;
  if (server.transport === 'stdio') {
    return blockedAgentMcpAction(
      'mcp_server_connect',
      'Connecting stdio MCP servers is user-surface only because it can spawn host processes.',
    );
  }
  if (server.auth?.kind === 'header') {
    return blockedAgentMcpAction(
      'mcp_server_connect',
      'Connecting header-authenticated MCP servers is user-surface only because it forwards environment-backed secrets.',
    );
  }
  if (server.auth?.kind === 'oauth' && server.auth.clientSecret) {
    return blockedAgentMcpAction(
      'mcp_server_connect',
      'Connecting OAuth MCP servers with client-secret references is user-surface only because it forwards environment-backed secrets.',
    );
  }
  return null;
}

function blockedAgentMcpAction(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    requires: ['user-owned-surface'],
  };
}
