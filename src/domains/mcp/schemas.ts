import * as v from 'valibot';

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const mcpServerIdSchema = v.pipe(
  v.string(),
  v.regex(
    /^[a-z][a-z0-9-]{1,31}$/,
    'Expected a lowercase MCP server id using 2-32 letters, numbers, or dashes.',
  ),
);
export const mcpToolNameSchema = nonEmptyStringSchema;
export const mcpEnvVarNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, 'Expected an environment variable name.'),
);

export const mcpEnvRefSchema = v.strictObject({
  env: mcpEnvVarNameSchema,
});

export const mcpToolPolicySchema = v.strictObject({
  autoApprove: v.optional(v.array(mcpToolNameSchema)),
  deny: v.optional(v.array(mcpToolNameSchema)),
});

const mcpNoneAuthSchema = v.strictObject({
  kind: v.literal('none'),
});

const mcpHeaderAuthSchema = v.strictObject({
  kind: v.literal('header'),
  headers: v.record(nonEmptyStringSchema, mcpEnvRefSchema),
});

const mcpOAuthAuthSchema = v.strictObject({
  kind: v.literal('oauth'),
  clientId: v.optional(nonEmptyStringSchema),
  clientSecret: v.optional(mcpEnvRefSchema),
});

export const mcpAuthConfigSchema = v.variant('kind', [
  mcpNoneAuthSchema,
  mcpHeaderAuthSchema,
  mcpOAuthAuthSchema,
]);

const mcpCommonServerFields = {
  enabled: v.optional(v.boolean()),
  tools: v.optional(mcpToolPolicySchema),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
};

const mcpHttpServerSchema = v.pipe(
  v.strictObject({
    ...mcpCommonServerFields,
    transport: v.literal('http'),
    url: nonEmptyStringSchema,
    sse: v.optional(v.boolean()),
    auth: v.optional(mcpAuthConfigSchema),
  }),
  v.check(
    (server) => isAllowedMcpHttpUrl(server.url),
    'MCP HTTP servers must use https:// except localhost and 127.0.0.1.',
  ),
  v.check(
    (server) => server.auth?.kind !== 'oauth' || server.transport === 'http',
    'OAuth MCP auth is only valid for HTTP servers.',
  ),
);

const mcpStdioServerSchema = v.strictObject({
  ...mcpCommonServerFields,
  transport: v.literal('stdio'),
  command: nonEmptyStringSchema,
  args: v.optional(v.array(v.string())),
  cwd: v.optional(nonEmptyStringSchema),
  env: v.optional(v.record(mcpEnvVarNameSchema, mcpEnvRefSchema)),
});

export const mcpServerConfigSchema = v.variant('transport', [
  mcpHttpServerSchema,
  mcpStdioServerSchema,
]);

export const mcpConfigSchema = v.strictObject({
  servers: v.record(mcpServerIdSchema, mcpServerConfigSchema),
});

export const mcpActionResultSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const mcpEmptyInputSchema = v.object({});

export const mcpServerIdInputSchema = v.object({
  id: mcpServerIdSchema,
});

export const mcpServerAddInputSchema = v.object({
  id: mcpServerIdSchema,
  server: mcpServerConfigSchema,
});

export const mcpServerUpdateInputSchema = v.object({
  id: mcpServerIdSchema,
  server: v.record(v.string(), v.unknown()),
});

export const mcpServerRemoveInputSchema = v.object({
  id: mcpServerIdSchema,
  confirm: v.optional(v.boolean()),
});

export const mcpApprovalResolveInputSchema = v.object({
  id: nonEmptyStringSchema,
  decision: v.picklist(['approve', 'deny']),
  approverSurface: v.optional(nonEmptyStringSchema),
  confirm: v.optional(v.boolean()),
});

export const mcpListAuditInputSchema = v.object({
  serverId: v.optional(mcpServerIdSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export type McpConfig = v.InferOutput<typeof mcpConfigSchema>;
export type McpServerConfig = v.InferOutput<typeof mcpServerConfigSchema>;
export type McpToolPolicy = v.InferOutput<typeof mcpToolPolicySchema>;
export type McpAuthConfig = v.InferOutput<typeof mcpAuthConfigSchema>;
export type McpEnvRef = v.InferOutput<typeof mcpEnvRefSchema>;

export function parseMcpConfig(value: unknown, path: string): McpConfig {
  const result = v.safeParse(mcpConfigSchema, value);
  if (!result.success) {
    throw new Error(`${path}: ${v.summarize(result.issues)}`);
  }
  return result.output;
}

export function defaultMcpConfig(): McpConfig {
  return { servers: {} };
}

export function mcpServerEnabled(server: McpServerConfig) {
  return server.enabled ?? true;
}

function isAllowedMcpHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}
