#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const server = new McpServer({
  name: 'neondeck-test-mcp',
  version: '1.0.0',
});

server.registerTool(
  'echo',
  {
    description: 'Echo back text for Neondeck MCP tests.',
    inputSchema: {
      text: z.string(),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo:${text}` }],
    structuredContent: { echoed: text },
  }),
);

server.registerTool(
  'danger',
  {
    description: 'Denied test tool.',
    inputSchema: {
      text: z.string(),
    },
    annotations: {
      destructiveHint: true,
    },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `danger:${text}` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
