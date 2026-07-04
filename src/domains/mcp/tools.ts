import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import { getMcpRegistry } from './registry';
import { mcpListAuditInputSchema, mcpServerIdSchema } from './schemas';
import { listMcpApprovals, listMcpAudit } from './store';

const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const mcpServersLookupTool = defineTool({
  name: 'neondeck_mcp_servers_lookup',
  description: 'List configured MCP servers with live connection status.',
  input: v.object({}),
  output: outputSchema,
  async run() {
    const paths = runtimePaths();
    const servers = await getMcpRegistry(paths).status();
    return {
      ok: true,
      action: 'mcp_servers_lookup',
      changed: false,
      message: `Read ${servers.length} MCP server statuses.`,
      servers,
    };
  },
});

export const mcpToolsLookupTool = defineTool({
  name: 'neondeck_mcp_tools_lookup',
  description:
    'List cached MCP tool catalogs. Live calls still require a connected server and approval policy.',
  input: v.object({
    id: v.optional(mcpServerIdSchema),
  }),
  output: outputSchema,
  async run({ input }) {
    const paths = runtimePaths();
    const tools = await getMcpRegistry(paths).listTools(input.id);
    return {
      ok: true,
      action: 'mcp_tools_lookup',
      changed: false,
      message: `Read ${tools.length} cached MCP tools.`,
      tools,
    };
  },
});

export const mcpStatusLookupTool = defineTool({
  name: 'neondeck_mcp_status_lookup',
  description: 'Read MCP registry status and enabled server health.',
  input: v.object({}),
  output: outputSchema,
  async run() {
    const paths = runtimePaths();
    const servers = await getMcpRegistry(paths).status();
    return {
      ok: true,
      action: 'mcp_status_lookup',
      changed: false,
      message: `Read ${servers.length} MCP server statuses.`,
      servers,
    };
  },
});

export const mcpApprovalsLookupTool = defineTool({
  name: 'neondeck_mcp_approvals_lookup',
  description: 'List pending MCP tool-call approvals.',
  input: v.object({
    includeResolved: v.optional(v.boolean()),
  }),
  output: outputSchema,
  async run({ input }) {
    const approvals = await listMcpApprovals(runtimePaths(), {
      includeResolved: input.includeResolved,
    });
    return {
      ok: true,
      action: 'mcp_approvals_lookup',
      changed: false,
      message: `Read ${approvals.length} MCP approval records.`,
      approvals,
    };
  },
});

export const mcpAuditLookupTool = defineTool({
  name: 'neondeck_mcp_audit_lookup',
  description: 'List recent MCP tool-call audit rows.',
  input: mcpListAuditInputSchema,
  output: outputSchema,
  async run({ input }) {
    const audit = await listMcpAudit(runtimePaths(), {
      serverId: input.serverId,
      limit: input.limit,
    });
    return {
      ok: true,
      action: 'mcp_audit_lookup',
      changed: false,
      message: `Read ${audit.length} MCP audit rows.`,
      audit,
    };
  },
});

export const neondeckMcpTools = [
  mcpServersLookupTool,
  mcpToolsLookupTool,
  mcpStatusLookupTool,
  mcpApprovalsLookupTool,
  mcpAuditLookupTool,
];
