import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import {
  addMcpServer,
  removeMcpServer,
  setMcpServerEnabled,
  updateMcpServer,
} from './config';
import { getMcpRegistry } from './registry';
import {
  mcpActionResultSchema,
  mcpApprovalResolveInputSchema,
  mcpEmptyInputSchema,
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

export const mcpRegistryRefreshAction = defineAction({
  name: 'neondeck_mcp_registry_refresh',
  description: 'Refresh MCP server connections and cached tool catalogs.',
  input: v.object({
    id: v.optional(mcpServerIdSchema),
  }),
  output: mcpActionResultSchema,
  async run({ input }) {
    const paths = runtimePaths();
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
  mcpApprovalResolveAction,
  mcpRegistryRefreshAction,
  mcpStatusAction,
];
