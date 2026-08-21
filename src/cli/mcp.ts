import type { Command } from 'commander';
import type { RuntimePaths } from '../runtime-home';
import { mcpModule } from './modules';
import {
  loadEnvForPaths,
  parseOptionalLimit,
  pathsFromOptions,
} from './options';
import {
  isJsonOutput,
  numberField,
  objectField,
  printActionResult,
  stringField,
} from './output';
import { expandHome } from './prompts';
import type { GlobalOptions } from './types';

type McpAddOptions = {
  url?: string;
  command?: string;
  arg?: string[];
  cwd?: string;
  env?: string[];
  header?: string[];
  oauth?: boolean;
  disabled?: boolean;
  approvalMode?: string;
  tool?: string[];
  timeoutMs?: string;
};

type McpApprovalOptions = {
  includeResolved?: boolean;
  resolve?: string;
  approve?: boolean;
  deny?: boolean;
  scope?: string;
};

type McpRegistry = ReturnType<
  Awaited<ReturnType<typeof mcpModule>>['getMcpRegistry']
>;
type McpConfig = Awaited<
  ReturnType<Awaited<ReturnType<typeof mcpModule>>['readMcpConfig']>
>;
type McpServerConfig = McpConfig['servers'][string];
type McpToolPolicy = NonNullable<McpServerConfig['tools']>;

export function registerMcpCommands(program: Command) {
  const mcp = program.command('mcp').description('Manage MCP servers.');

  mcp
    .command('list')
    .description('List configured MCP servers and connection status.')
    .action(async () => {
      const { getMcpRegistry } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          await registry.refresh();
          const servers = await registry.status();
          printMcpServers(servers);
        },
      );
    });

  mcp
    .command('status [id]')
    .description('Show MCP server connection status.')
    .action(async (id: string | undefined) => {
      const { getMcpRegistry } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          await registry.refresh(id);
          const servers = await registry.status();
          printMcpServers(
            id ? servers.filter((server) => server.id === id) : servers,
          );
        },
      );
    });

  mcp
    .command('add <id>')
    .description('Add an MCP server.')
    .option('--url <url>', 'streamable HTTP MCP endpoint')
    .option('--command <command>', 'stdio command')
    .option(
      '--arg <arg>',
      'stdio argument; repeat for multiple args',
      collectOption,
      [],
    )
    .option('--cwd <path>', 'stdio working directory')
    .option(
      '--env <name=ENV>',
      'stdio env forwarding; repeatable',
      collectOption,
      [],
    )
    .option(
      '--header <name=ENV>',
      'HTTP header env ref; repeatable',
      collectOption,
      [],
    )
    .option('--oauth', 'mark HTTP server as OAuth-authenticated')
    .option('--disabled', 'add the server disabled')
    .option(
      '--approval-mode <mode>',
      'default tool policy: prompt, writes, or approve',
    )
    .option(
      '--tool <name=mode>',
      'per-tool policy: prompt, approve, or deny; repeatable',
      collectOption,
      [],
    )
    .option('--timeout-ms <ms>', 'MCP request timeout in milliseconds')
    .action(async (id: string, options: McpAddOptions) => {
      const { addMcpServer, getMcpRegistry } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const server = mcpServerFromAddOptions(options);
      const result = await addMcpServer({ id, server }, paths);
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          if (result.ok) await registry.refresh(id);
          printActionResult(result);
        },
      );
    });

  mcp
    .command('policy <id>')
    .description('Update an MCP server tool approval policy.')
    .option(
      '--approval-mode <mode>',
      'default tool policy: prompt, writes, or approve',
    )
    .option(
      '--tool <name=mode>',
      'per-tool policy: prompt, approve, deny, or inherit; repeatable',
      collectOption,
      [],
    )
    .action(
      async (
        id: string,
        options: { approvalMode?: string; tool?: string[] },
      ) => {
        const { readMcpConfig, updateMcpServer } = await mcpModule();
        const paths = await pathsFromOptions(program.opts<GlobalOptions>());
        loadEnvForPaths(paths);
        if (!options.approvalMode && (options.tool?.length ?? 0) === 0) {
          throw new Error('MCP policy requires --approval-mode or --tool.');
        }
        const config = await readMcpConfig(paths);
        const existing = config.servers[id];
        if (!existing) throw new Error(`MCP server "${id}" was not found.`);
        const approvalMode = parseApprovalMode(
          options.approvalMode ?? existing.tools?.approvalMode ?? 'writes',
        );
        const overrides = { ...existing.tools?.overrides };
        for (const entry of options.tool ?? []) {
          const [toolName, mode] = parseToolOverride(entry, true);
          if (mode === 'inherit') delete overrides[toolName];
          else overrides[toolName] = mode;
        }
        const tools: McpToolPolicy = { approvalMode };
        if (Object.keys(overrides).length > 0) tools.overrides = overrides;
        printActionResult(
          await updateMcpServer(
            {
              id,
              server: {
                tools,
              },
            },
            paths,
          ),
        );
      },
    );

  mcp
    .command('remove <id>')
    .description('Remove an MCP server.')
    .option('--confirm', 'confirm removal')
    .action(async (id: string, options: { confirm?: boolean }) => {
      const { getMcpRegistry, removeMcpServer } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await removeMcpServer(
        { id, confirm: options.confirm },
        paths,
      );
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          if (result.ok) await registry.refresh(id);
          printActionResult(result);
        },
      );
    });

  mcp
    .command('enable <id>')
    .description('Enable an MCP server.')
    .action(async (id: string) => {
      const { getMcpRegistry, setMcpServerEnabled } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await setMcpServerEnabled({ id }, true, paths);
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          if (result.ok) await registry.refresh(id);
          printActionResult(result);
        },
      );
    });

  mcp
    .command('disable <id>')
    .description('Disable an MCP server.')
    .action(async (id: string) => {
      const { getMcpRegistry, setMcpServerEnabled } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await setMcpServerEnabled({ id }, false, paths);
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          if (result.ok) await registry.refresh(id);
          printActionResult(result);
        },
      );
    });

  mcp
    .command('tools <id>')
    .description('List cached tools for one MCP server.')
    .action(async (id: string) => {
      const { getMcpRegistry } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const tools = await getMcpRegistry(paths).listTools(id);
      printMcpTools(tools);
    });

  mcp
    .command('login <id>')
    .description('Start OAuth login for one MCP server.')
    .option('--redirect-url <url>', 'OAuth redirect URL for the running server')
    .action(async (id: string, options: { redirectUrl?: string }) => {
      const { startMcpOAuthLogin } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await startMcpOAuthLogin(
        { id, redirectUrl: options.redirectUrl },
        paths,
      );
      printMcpLoginResult(result);
    });

  mcp
    .command('logout <id>')
    .description('Remove stored OAuth tokens for one MCP server.')
    .option('--confirm', 'confirm logout')
    .action(async (id: string, options: { confirm?: boolean }) => {
      const { getMcpRegistry, logoutMcpOAuthServer } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const result = await logoutMcpOAuthServer(
        { id, confirm: options.confirm },
        paths,
      );
      await withTransientMcpRegistry(
        paths,
        getMcpRegistry,
        async (registry) => {
          if (result.ok) await registry.refresh(id);
          printActionResult(result);
        },
      );
    });

  mcp
    .command('approvals')
    .description('List or resolve MCP tool-call approvals.')
    .option('--include-resolved', 'include resolved approval rows')
    .option('--resolve <id>', 'approval id to resolve')
    .option('--approve', 'approve the selected approval')
    .option('--deny', 'deny the selected approval')
    .option(
      '--scope <scope>',
      'approval scope: once, chat, or always (default: once)',
    )
    .action(async (options: McpApprovalOptions) => {
      const { listMcpApprovals, resolveMcpApprovalWithPaths } =
        await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      if (options.resolve) {
        const decision = options.approve
          ? approvalDecision(options.scope)
          : options.deny
            ? 'deny'
            : null;
        if (!decision)
          throw new Error('--resolve requires --approve or --deny');
        printActionResult(
          await resolveMcpApprovalWithPaths(
            {
              id: options.resolve,
              decision,
              approverSurface: 'cli',
            },
            paths,
          ),
        );
        return;
      }

      const approvals = await listMcpApprovals(paths, {
        includeResolved: options.includeResolved,
      });
      printMcpApprovals(approvals);
    });

  mcp
    .command('audit')
    .description('List recent MCP tool-call audit rows.')
    .option('--server <id>', 'filter by server id')
    .option('--limit <count>', 'number of audit rows to show')
    .action(async (options: { server?: string; limit?: string }) => {
      const { listMcpAudit } = await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      const audit = await listMcpAudit(paths, {
        serverId: options.server,
        limit: parseOptionalLimit(options.limit),
      });
      printMcpAudit(audit);
    });
}

async function withTransientMcpRegistry<T>(
  paths: RuntimePaths,
  getMcpRegistry: (paths: RuntimePaths) => McpRegistry,
  run: (registry: McpRegistry) => Promise<T>,
) {
  const registry = getMcpRegistry(paths);
  try {
    return await run(registry);
  } finally {
    await registry.stop();
  }
}

function collectOption(value: string, previous: string[]) {
  return [...previous, value];
}

function mcpServerFromAddOptions(options: McpAddOptions): McpServerConfig {
  const timeoutMs = parseOptionalPositiveInteger(
    options.timeoutMs,
    '--timeout-ms',
  );
  const tools = mcpToolPolicy(options);

  if (options.url && options.command) {
    throw new Error('Use either --url or --command, not both.');
  }

  if (options.url) {
    const server: McpServerConfig = {
      transport: 'http' as const,
      url: options.url,
      enabled: !options.disabled,
      auth: mcpAuthFromOptions(options),
    };
    if (timeoutMs !== undefined) server.timeoutMs = timeoutMs;
    server.tools = tools;
    return server;
  }

  if (options.command) {
    if (options.oauth || options.header?.length) {
      throw new Error('--oauth and --header are only valid with --url.');
    }
    const server: McpServerConfig = {
      transport: 'stdio' as const,
      command: options.command,
      args: options.arg ?? [],
      enabled: !options.disabled,
    };
    if (options.cwd) server.cwd = expandHome(options.cwd);
    if (timeoutMs !== undefined) server.timeoutMs = timeoutMs;
    server.tools = tools;
    if (options.env?.length) {
      server.env = Object.fromEntries(options.env.map(parseEnvRefPair));
    }
    return server;
  }

  throw new Error('MCP add requires --url or --command.');
}

function mcpAuthFromOptions(options: McpAddOptions) {
  if (options.oauth) return { kind: 'oauth' as const };
  if (options.header?.length) {
    return {
      kind: 'header' as const,
      headers: Object.fromEntries(options.header.map(parseEnvRefPair)),
    };
  }
  return { kind: 'none' as const };
}

function mcpToolPolicy(options: McpAddOptions): McpToolPolicy {
  const approvalMode = parseApprovalMode(options.approvalMode ?? 'writes');
  const overrides: NonNullable<McpToolPolicy['overrides']> = {};
  for (const entry of options.tool ?? []) {
    const [toolName, mode] = parseToolOverride(entry, false);
    if (mode !== 'inherit') overrides[toolName] = mode;
  }
  const policy: McpToolPolicy = { approvalMode };
  if (Object.keys(overrides).length > 0) policy.overrides = overrides;
  return policy;
}

function parseApprovalMode(value: string) {
  if (value === 'prompt' || value === 'writes' || value === 'approve') {
    return value;
  }
  throw new Error('--approval-mode must be prompt, writes, or approve.');
}

function parseToolOverride(value: string, allowInherit: boolean) {
  const index = value.lastIndexOf('=');
  const toolName = value.slice(0, index).trim();
  const mode = value.slice(index + 1).trim();
  if (!toolName || index < 1) throw new Error('Expected TOOL=MODE.');
  if (
    mode !== 'prompt' &&
    mode !== 'approve' &&
    mode !== 'deny' &&
    !(allowInherit && mode === 'inherit')
  ) {
    throw new Error(
      `Tool mode must be prompt, approve, deny${allowInherit ? ', or inherit' : ''}.`,
    );
  }
  return [toolName, mode] as const;
}

function approvalDecision(scope: string | undefined) {
  if (scope === undefined || scope === 'once') return 'allow-once' as const;
  if (scope === 'chat') return 'allow-chat' as const;
  if (scope === 'always') return 'allow-always' as const;
  throw new Error('--scope must be once, chat, or always.');
}

function parseEnvRefPair(value: string): [string, { env: string }] {
  const index = value.indexOf('=');
  if (index <= 0 || index === value.length - 1) {
    throw new Error('Expected NAME=ENV.');
  }
  return [value.slice(0, index), { env: value.slice(index + 1) }];
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  option: string,
) {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${option} must be an integer.`);
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${option} must be an integer >= 1.`);
  }
  return number;
}

function printMcpServers(servers: unknown[]) {
  if (isJsonOutput()) {
    console.log(JSON.stringify({ servers }, null, 2));
    return;
  }
  if (servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  for (const server of servers.map(objectField)) {
    console.log(
      `${stringField(server, 'id').padEnd(18)} ${stringField(server, 'transport').padEnd(6)} ${stringField(server, 'status').padEnd(13)} ${numberField(server, 'toolCount')} tools`,
    );
    const message = stringField(server, 'message');
    if (message) console.log(`  ${message}`);
    console.log(
      `  tool approval: ${stringField(server, 'approvalMode') || 'writes'}`,
    );
  }
}

function printMcpTools(tools: unknown[]) {
  if (isJsonOutput()) {
    console.log(JSON.stringify({ tools }, null, 2));
    return;
  }
  if (tools.length === 0) {
    console.log('No cached MCP tools.');
    return;
  }
  for (const tool of tools.map(objectField)) {
    console.log(
      `${stringField(tool, 'adaptedName').padEnd(42)} ${stringField(tool, 'status')}`,
    );
    const description = stringField(tool, 'description');
    if (description) console.log(`  ${description.slice(0, 160)}`);
  }
}

function printMcpLoginResult(result: {
  ok: boolean;
  message: string;
  authorizationUrl?: string | null;
  loginId?: string;
  requires?: string[];
}) {
  if (isJsonOutput() || !result.ok) {
    printActionResult(result);
    return;
  }

  console.log(`✓ ${result.message}`);
  const authorizationUrl = result.authorizationUrl;
  if (authorizationUrl) {
    console.log(`authorizationUrl: ${authorizationUrl}`);
    console.log(
      'Open that URL in a browser, then keep the Neondeck server running for the callback.',
    );
  }
  if (result.loginId) console.log(`loginId: ${result.loginId}`);
}

function printMcpApprovals(approvals: unknown[]) {
  if (isJsonOutput()) {
    console.log(JSON.stringify({ approvals }, null, 2));
    return;
  }
  if (approvals.length === 0) {
    console.log('No MCP approvals.');
    return;
  }
  for (const approval of approvals.map(objectField)) {
    console.log(
      `${stringField(approval, 'updatedAt')} ${stringField(approval, 'status').padEnd(9)} ${stringField(approval, 'adaptedName')} ${stringField(approval, 'id')}`,
    );
  }
}

function printMcpAudit(audit: unknown[]) {
  if (isJsonOutput()) {
    console.log(JSON.stringify({ audit }, null, 2));
    return;
  }
  if (audit.length === 0) {
    console.log('No MCP audit rows.');
    return;
  }
  for (const row of audit.map(objectField)) {
    console.log(
      `${stringField(row, 'createdAt')} ${stringField(row, 'decision').padEnd(9)} ${String(row.ok === true ? 'ok' : 'fail').padEnd(4)} ${stringField(row, 'adaptedName')}`,
    );
    const error = stringField(row, 'error');
    if (error) console.log(`  ${error}`);
  }
}
