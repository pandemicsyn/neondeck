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

if (process.env.NEONDECK_MCP_DUPLICATE_TOOLS === '1') {
  server.registerTool(
    'foo.bar',
    {
      description: 'Duplicate adapted-name fixture.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'foo.bar' }],
    }),
  );

  server.registerTool(
    'foo/bar',
    {
      description: 'Duplicate adapted-name fixture.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'foo/bar' }],
    }),
  );
}

if (process.env.NEONDECK_MCP_ONLY_ECHO !== '1') {
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
}

const startDelayMs = Number(process.env.NEONDECK_MCP_START_DELAY_MS ?? 0);
if (Number.isFinite(startDelayMs) && startDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, startDelayMs));
}

const transport = new StdioServerTransport();
await server.connect(transport);
