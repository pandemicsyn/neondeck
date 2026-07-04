import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import Ajv, { type ValidateFunction } from 'ajv';
import * as v from 'valibot';
import { adaptedMcpToolName } from './format';
import type { McpServerConfig } from './schemas';

export type McpSdkConnection = {
  serverId: string;
  tools: ToolDefinition[];
  catalog: McpSdkToolCatalog[];
  close(): Promise<void>;
};

export type McpSdkToolCatalog = {
  serverId: string;
  toolName: string;
  adaptedName: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
};

export type McpToolDelegate = (context: {
  input: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<McpToolDelegateResult>;

export type McpToolDelegateResult = {
  text: string;
  structuredContent?: Record<string, unknown>;
  raw: CallToolResult;
};

export type McpToolEnvelope = {
  ok: boolean;
  status: string;
  server: string;
  tool: string;
  untrusted: boolean;
  [key: string]: unknown;
};

export type McpToolGate = (input: {
  serverId: string;
  toolName: string;
  adaptedName: string;
  run: McpToolDelegate;
  context: {
    input: Record<string, unknown>;
    signal?: AbortSignal;
  };
}) => Promise<McpToolEnvelope>;

export async function connectSdkMcpServer(input: {
  serverId: string;
  server: McpServerConfig;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  gate: McpToolGate;
}): Promise<McpSdkConnection> {
  const client = new Client({
    name: 'neondeck',
    version: '1.0.0',
  });
  const requestOptions = requestOptionsForServer(input.server);
  const transport = createTransport(
    input.server,
    input.headers,
    input.authProvider,
  );

  try {
    await client.connect(transport);
    const tools = (await listAllTools(client, requestOptions)).filter(
      (tool) => tool.execution?.taskSupport !== 'required',
    );
    assertUniqueAdaptedNames(input.serverId, tools);
    const adapted = tools.map((tool) =>
      createMcpToolDefinition({
        serverId: input.serverId,
        tool,
        requestOptions,
        client,
        gate: input.gate,
      }),
    );
    return {
      serverId: input.serverId,
      tools: adapted.map((item) => item.tool),
      catalog: adapted.map((item) => item.catalog),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function createTransport(
  server: McpServerConfig,
  headers: Record<string, string> | undefined,
  authProvider: OAuthClientProvider | undefined,
) {
  if (server.transport === 'stdio') {
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      cwd: server.cwd,
      env: resolveStdioEnv(server),
      stderr: 'pipe',
    });
  }

  const requestInit = headers ? { headers } : undefined;
  const url = new URL(server.url);
  if (server.sse) {
    return new SSEClientTransport(url, { requestInit, authProvider });
  }
  return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
}

function resolveStdioEnv(server: McpServerConfig) {
  if (server.transport !== 'stdio' || !server.env) return undefined;
  const env: Record<string, string> = {};
  for (const [target, ref] of Object.entries(server.env)) {
    const value = process.env[ref.env];
    if (value !== undefined) env[target] = value;
  }
  return env;
}

async function listAllTools(client: Client, requestOptions: RequestOptions) {
  let page = await client.listTools(undefined, requestOptions);
  const tools = [...page.tools];
  const seenCursors = new Set<string>();

  while (page.nextCursor !== undefined) {
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `MCP server repeated tools/list cursor ${JSON.stringify(page.nextCursor)}.`,
      );
    }
    seenCursors.add(page.nextCursor);
    page = await client.listTools({ cursor: page.nextCursor }, requestOptions);
    tools.push(...page.tools);
  }

  return tools;
}

function createMcpToolDefinition(input: {
  serverId: string;
  tool: Tool;
  requestOptions: RequestOptions;
  client: Client;
  gate: McpToolGate;
}) {
  const adaptedName = adaptedMcpToolName(input.serverId, input.tool.name);
  const description = createToolDescription(input.serverId, input.tool);
  const inputValidator = compileJsonSchema(input.tool.inputSchema);
  const outputValidator = input.tool.outputSchema
    ? compileJsonSchema(input.tool.outputSchema)
    : null;
  const inputSchema = inputSchemaToValibot(
    input.tool.inputSchema,
    inputValidator,
  );
  const output = v.looseObject({
    ok: v.boolean(),
    status: v.string(),
    server: v.string(),
    tool: v.string(),
    untrusted: v.boolean(),
  });
  const tool = defineTool({
    name: adaptedName,
    description,
    input: inputSchema,
    output,
    async run(context) {
      assertJsonSchema(
        inputValidator,
        context.input,
        `Input for MCP tool "${input.tool.name}"`,
      );
      return input.gate({
        serverId: input.serverId,
        toolName: input.tool.name,
        adaptedName,
        context: {
          input: context.input,
          signal: context.signal,
        },
        run: async ({ input: args, signal }) => {
          const result = (await input.client.callTool(
            {
              name: input.tool.name,
              arguments: args,
            },
            CallToolResultSchema,
            {
              ...input.requestOptions,
              signal,
            },
          )) as CallToolResult;
          const text = formatMcpResult(result);
          if (result.isError) {
            throw new Error(text);
          }
          if (outputValidator) {
            if (result.structuredContent === undefined) {
              throw new Error(
                `MCP tool "${input.tool.name}" returned no structuredContent for its declared output schema.`,
              );
            }
            assertJsonSchema(
              outputValidator,
              result.structuredContent,
              `Structured output for MCP tool "${input.tool.name}"`,
            );
          }
          return {
            text,
            structuredContent: boundedStructuredContent(
              result.structuredContent,
            ),
            raw: result,
          };
        },
      });
    },
  });

  return {
    tool,
    catalog: {
      serverId: input.serverId,
      toolName: input.tool.name,
      adaptedName,
      description,
      inputSchema: input.tool.inputSchema,
      outputSchema: input.tool.outputSchema,
      annotations: input.tool.annotations ?? null,
    },
  };
}

function requestOptionsForServer(server: McpServerConfig): RequestOptions {
  return {
    timeout: server.timeoutMs,
  };
}

function createToolDescription(serverName: string, tool: Tool) {
  const originalName = tool.name;
  const title = tool.title ?? tool.annotations?.title;
  const parts = [`MCP tool "${originalName}" from server "${serverName}".`];
  if (title && title !== originalName) parts.push(`Title: ${title}.`);
  if (tool.description) parts.push(tool.description);
  return parts.join(' ');
}

const ajv = new Ajv({ allErrors: true, strict: false });
const maxMcpOutputPartChars = 8_000;
const maxMcpOutputTotalChars = 24_000;

function assertUniqueAdaptedNames(serverId: string, tools: Tool[]) {
  const seen = new Map<string, string>();
  for (const tool of tools) {
    const adaptedName = adaptedMcpToolName(serverId, tool.name);
    const existing = seen.get(adaptedName);
    if (existing) {
      throw new Error(
        `MCP server "${serverId}" exposes duplicate adapted tool name "${adaptedName}" for "${existing}" and "${tool.name}".`,
      );
    }
    seen.set(adaptedName, tool.name);
  }
}

function compileJsonSchema(schema: object): ValidateFunction {
  return ajv.compile(schema);
}

function assertJsonSchema(
  validate: ValidateFunction,
  value: unknown,
  label: string,
) {
  if (validate(value)) return;
  const detail =
    validate.errors
      ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ') || 'unknown schema mismatch';
  throw new Error(`${label} does not match declared JSON Schema: ${detail}`);
}

function inputSchemaToValibot(
  schema: Tool['inputSchema'],
  validate: ValidateFunction,
) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries: Record<string, v.GenericSchema> = {};

  for (const [key, value] of Object.entries(properties)) {
    const property = jsonSchemaToValibot(value);
    entries[key] = required.has(key) ? property : v.optional(property);
  }

  return v.pipe(
    v.looseObject(entries),
    v.check(
      (value) => validate(value),
      'Input did not match the MCP tool JSON Schema.',
    ),
  );
}

function jsonSchemaToValibot(schema: object): v.GenericSchema {
  const record = schema as Record<string, unknown>;
  const enumValues = Array.isArray(record.enum) ? record.enum : undefined;
  if (enumValues?.length) {
    return v.pipe(
      v.unknown(),
      v.check(
        (value) => enumValues.includes(value),
        `Expected one of: ${enumValues.map(String).join(', ')}`,
      ),
    );
  }

  if (Array.isArray(record.type)) return v.unknown();
  const type = record.type;
  if (type === 'string') return v.string();
  if (type === 'number') return v.number();
  if (type === 'integer') return v.pipe(v.number(), v.integer());
  if (type === 'boolean') return v.boolean();
  if (type === 'array') {
    const itemSchema =
      record.items && typeof record.items === 'object'
        ? jsonSchemaToValibot(record.items)
        : v.unknown();
    return v.array(itemSchema);
  }
  if (type === 'object' || record.properties) {
    const properties =
      record.properties && typeof record.properties === 'object'
        ? (record.properties as Record<string, object>)
        : {};
    const required = new Set(
      Array.isArray(record.required) ? record.required.map(String) : [],
    );
    const entries: Record<string, v.GenericSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      const property = jsonSchemaToValibot(value);
      entries[key] = required.has(key) ? property : v.optional(property);
    }
    return v.looseObject(entries);
  }

  return v.unknown();
}

function formatMcpResult(result: CallToolResult) {
  const parts: string[] = [];
  const addPart = (value: string) => {
    if (!value) return;
    const remaining =
      maxMcpOutputTotalChars -
      parts.join('\n\n').length -
      (parts.length ? 2 : 0);
    if (remaining <= 0) return;
    const part = truncateMcpOutputPart(value);
    parts.push(
      part.length > remaining
        ? `${part.slice(0, Math.max(0, remaining - 22))}\n[truncated output]`
        : part,
    );
  };

  if (result.structuredContent !== undefined) {
    addPart(
      `Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`,
    );
  }

  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      addPart(item.text);
      continue;
    }
    if (item.type === 'image') {
      addPart(`[Image: ${item.mimeType}, ${item.data.length} base64 chars]`);
      continue;
    }
    if (item.type === 'audio') {
      addPart(`[Audio: ${item.mimeType}, ${item.data.length} base64 chars]`);
      continue;
    }
    if (item.type === 'resource') {
      const resource = item.resource;
      if ('text' in resource) {
        addPart(`[Resource: ${resource.uri}]\n${resource.text}`);
      } else {
        addPart(
          `[Resource: ${resource.uri}, ${resource.blob.length} base64 chars]`,
        );
      }
      continue;
    }
    if (item.type === 'resource_link') {
      const description = item.description ? ` - ${item.description}` : '';
      addPart(`[Resource link: ${item.name} (${item.uri})${description}]`);
      continue;
    }
    addPart(JSON.stringify(item));
  }

  return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}

function truncateMcpOutputPart(value: string) {
  if (value.length <= maxMcpOutputPartChars) return value;
  return `${value.slice(0, maxMcpOutputPartChars - 22)}\n[truncated output]`;
}

function boundedStructuredContent(value: unknown) {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json.length <= maxMcpOutputPartChars) {
    return isRecord(value) ? value : { value };
  }
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    preview: `${json.slice(0, maxMcpOutputPartChars - 22)}\n[truncated output]`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
