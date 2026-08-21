import { defineTool } from '@flue/runtime';
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
  mcpExternalRecordSchema,
  type McpExternalRecord,
  type McpExternalValue,
  type McpServerConfig,
} from './schemas';
import { resolveMcpApprovalWithPaths } from './store';
import { runtimePaths } from '../../runtime-home';

export const mcpServerAddAction = defineTool({
  name: 'neondeck_mcp_server_add',
  description:
    'Add one MCP server to mcp.json using strict config validation and environment-variable secret references.',
  input: mcpServerAddInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = guardAgentMcpServerConfig(input.server, 'mcp_server_add');
    if (guard) return { output: guard };
    const result = await addMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: result };
  },
});

export const mcpServerUpdateAction = defineTool({
  name: 'neondeck_mcp_server_update',
  description:
    'Update one configured MCP server in mcp.json using strict config validation. Model-owned updates may change ordinary state or configure safe HTTP OAuth without a client secret; endpoint, process, header-auth, client-secret, and tool approval changes require a user-owned surface.',
  input: mcpServerUpdateInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerUpdate(
      input.id,
      input.server,
      paths,
    );
    if (guard) return { output: guard };
    const result = await updateMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: result };
  },
});

export const mcpServerRemoveAction = defineTool({
  name: 'neondeck_mcp_server_remove',
  description:
    'Remove one configured MCP server and its cached MCP state. Requires confirm=true.',
  input: mcpServerRemoveInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerUserOwnedMutation(
      input.id,
      'mcp_server_remove',
      paths,
    );
    if (guard) return { output: guard };
    const result = await removeMcpServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: result };
  },
});

export const mcpServerEnableAction = defineTool({
  name: 'neondeck_mcp_server_enable',
  description: 'Enable one configured MCP server and refresh its connection.',
  input: mcpServerIdInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerConnect(input.id, paths);
    if (guard) return { output: guard };
    const result = await setMcpServerEnabled(input, true, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: { ...result, action: 'mcp_server_enable' } };
  },
});

export const mcpServerDisableAction = defineTool({
  name: 'neondeck_mcp_server_disable',
  description: 'Disable one configured MCP server and close its connection.',
  input: mcpServerIdInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerUserOwnedMutation(
      input.id,
      'mcp_server_disable',
      paths,
    );
    if (guard) return { output: guard };
    const result = await setMcpServerEnabled(input, false, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: { ...result, action: 'mcp_server_disable' } };
  },
});

export const mcpApprovalResolveAction = defineTool({
  name: 'neondeck_mcp_approval_resolve',
  description:
    'Allow one exact pending MCP tool call or deny it. Chat-wide and persistent policy changes require a user-owned surface. Requires confirm=true.',
  input: mcpApprovalResolveInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    if (!input.confirm) {
      return {
        output: {
          ok: false,
          action: 'mcp_approval_resolve',
          changed: false,
          message: 'Resolving MCP approvals requires confirm=true.',
          requires: ['confirm'],
        },
      };
    }
    if (input.decision === 'allow-chat' || input.decision === 'allow-always') {
      return {
        output: {
          ok: false,
          action: 'mcp_approval_resolve',
          changed: false,
          message:
            'Chat-wide and always-allow MCP decisions must be made from the dashboard or CLI.',
          requires: ['userOwnedSurface'],
        },
      };
    }
    return { output: await resolveMcpApprovalWithPaths(input, runtimePaths()) };
  },
});

export const mcpLoginStartAction = defineTool({
  name: 'neondeck_mcp_login_start',
  description:
    'Start OAuth login for one configured MCP server and return a user-facing authorization URL.',
  input: mcpLoginStartInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerCredentialMutation(
      input.id,
      'mcp_login_start',
      paths,
    );
    if (guard) return { output: guard };
    return { output: await startMcpOAuthLogin(input, paths) };
  },
});

export const mcpLogoutAction = defineTool({
  name: 'neondeck_mcp_logout',
  description:
    'Remove stored OAuth tokens for one MCP server. Requires confirm=true.',
  input: mcpLogoutInputSchema,
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    const guard = await guardAgentMcpServerCredentialMutation(
      input.id,
      'mcp_logout',
      paths,
    );
    if (guard) return { output: guard };
    const result = await logoutMcpOAuthServer(input, paths);
    if (result.ok) await getMcpRegistry(paths).refresh(input.id);
    return { output: result };
  },
});

export const mcpRegistryRefreshAction = defineTool({
  name: 'neondeck_mcp_registry_refresh',
  description: 'Refresh MCP server connections and cached tool catalogs.',
  input: v.object({
    id: v.optional(mcpServerIdSchema),
  }),
  output: mcpActionResultSchema,
  async run({ data: input }) {
    const paths = runtimePaths();
    if (!input.id) {
      return {
        output: {
          ok: false,
          action: 'mcp_registry_refresh',
          changed: false,
          message:
            'Model-callable MCP refresh requires a single safe HTTP/OAuth server id. Use the dashboard or CLI for full registry refresh.',
          requires: ['id'],
        },
      };
    }
    const guard = await guardAgentMcpServerConnect(input.id, paths);
    if (guard) return { output: { ...guard, action: 'mcp_registry_refresh' } };
    const refreshed = await getMcpRegistry(paths).refresh(input.id);
    if (!refreshed) {
      return {
        output: {
          ok: false,
          action: 'mcp_registry_refresh',
          changed: false,
          message: `MCP server "${input.id}" was not found.`,
          requires: ['id'],
        },
      };
    }
    return {
      output: {
        ok: true,
        action: 'mcp_registry_refresh',
        changed: false,
        message: input.id
          ? `Refreshed MCP server "${input.id}".`
          : 'Refreshed MCP registry.',
      },
    };
  },
});

export const mcpStatusAction = defineTool({
  name: 'neondeck_mcp_status',
  description: 'Read MCP server connection status and tool counts.',
  input: mcpEmptyInputSchema,
  output: mcpActionResultSchema,
  async run() {
    const paths = runtimePaths();
    const servers = await getMcpRegistry(paths).status();
    return {
      output: {
        ok: true,
        action: 'mcp_status',
        changed: false,
        message: `Read ${servers.length} MCP server statuses.`,
        servers,
      },
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

function guardAgentMcpServerConfig(server: McpServerConfig, action: string) {
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
  if (server.tools !== undefined) {
    return blockedAgentMcpAction(
      action,
      'MCP tool approval policy can only be configured from the dashboard, CLI, or direct config edit.',
    );
  }
  return null;
}

async function guardAgentMcpServerUpdate(
  id: string,
  patch: McpExternalRecord,
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
  if (
    existing.transport === 'http' &&
    existing.auth?.kind === 'oauth' &&
    existing.auth.clientSecret
  ) {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'OAuth MCP servers with client-secret references can only be updated from a user-owned surface.',
    );
  }
  if (Object.hasOwn(patch, 'auth') && !isSafeAgentOAuthPatch(patch.auth)) {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'Header auth, OAuth client-secret references, and removing OAuth authentication must be configured from a user-owned surface.',
    );
  }
  if (hasUserOwnedMcpUpdateField(patch)) {
    return blockedAgentMcpAction(
      'mcp_server_update',
      'Endpoint, transport, stdio process, and MCP tool-policy changes must be made from a user-owned surface so existing approvals and approval policy cannot be retargeted by the model.',
    );
  }
  return null;
}

function isSafeAgentOAuthPatch(auth: McpExternalValue) {
  if (Array.isArray(auth)) return false;
  const parsed = v.safeParse(mcpExternalRecordSchema, auth);
  return (
    parsed.success &&
    parsed.output.kind === 'oauth' &&
    !Object.hasOwn(parsed.output, 'clientSecret')
  );
}

function hasUserOwnedMcpUpdateField(patch: McpExternalRecord) {
  return ['transport', 'url', 'tools', 'command', 'args', 'cwd', 'env'].some(
    (key) => Object.hasOwn(patch, key),
  );
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

async function guardAgentMcpServerUserOwnedMutation(
  id: string,
  action: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const config = await readMcpConfig(paths);
  const server = config.servers[id];
  if (!server) return null;
  if (server.transport === 'stdio') {
    return blockedAgentMcpAction(
      action,
      'Stdio MCP servers can only be changed from a user-owned surface because they can spawn host processes.',
    );
  }
  if (server.auth?.kind === 'header') {
    return blockedAgentMcpAction(
      action,
      'Header-authenticated MCP servers can only be changed from a user-owned surface because they forward environment-backed secrets.',
    );
  }
  if (server.auth?.kind === 'oauth' && server.auth.clientSecret) {
    return blockedAgentMcpAction(
      action,
      'OAuth MCP servers with client-secret references can only be changed from a user-owned surface because they forward environment-backed secrets.',
    );
  }
  return null;
}

async function guardAgentMcpServerCredentialMutation(
  id: string,
  action: string,
  paths: ReturnType<typeof runtimePaths>,
) {
  const config = await readMcpConfig(paths);
  const server = config.servers[id];
  if (!server) return null;
  if (
    server.transport === 'http' &&
    server.auth?.kind === 'oauth' &&
    server.auth.clientSecret
  ) {
    return blockedAgentMcpAction(
      action,
      'OAuth MCP servers with client-secret references can only be authorized from a user-owned surface because they forward environment-backed secrets.',
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
