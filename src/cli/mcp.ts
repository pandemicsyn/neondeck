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
  sse?: boolean;
  command?: string;
  arg?: string[];
  cwd?: string;
  env?: string[];
  header?: string[];
  oauth?: boolean;
  disabled?: boolean;
  autoApprove?: string[];
  deny?: string[];
  timeoutMs?: string;
};

type McpApprovalOptions = {
  includeResolved?: boolean;
  resolve?: string;
  approve?: boolean;
  deny?: boolean;
};

type McpRegistry = ReturnType<
  Awaited<ReturnType<typeof mcpModule>>['getMcpRegistry']
>;

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
    .option('--url <url>', 'streamable HTTP or SSE MCP endpoint')
    .option('--sse', 'use legacy SSE transport for HTTP MCP')
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
      '--auto-approve <tool>',
      'auto-approve exact tool name; repeatable',
      collectOption,
      [],
    )
    .option(
      '--deny <tool>',
      'deny exact tool name; repeatable',
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
    .action(async (options: McpApprovalOptions) => {
      const { listMcpApprovals, resolveMcpApprovalWithPaths } =
        await mcpModule();
      const paths = await pathsFromOptions(program.opts<GlobalOptions>());
      loadEnvForPaths(paths);
      if (options.resolve) {
        const decision = options.approve
          ? 'approve'
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

function mcpServerFromAddOptions(options: McpAddOptions) {
  const timeoutMs = parseOptionalPositiveInteger(
    options.timeoutMs,
    '--timeout-ms',
  );
  const tools = mcpToolPolicy(options);

  if (options.url && options.command) {
    throw new Error('Use either --url or --command, not both.');
  }

  if (options.url) {
    return {
      transport: 'http' as const,
      url: options.url,
      ...(options.sse ? { sse: true } : {}),
      enabled: !options.disabled,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(tools ? { tools } : {}),
      auth: mcpAuthFromOptions(options),
    };
  }

  if (options.command) {
    if (options.oauth || options.header?.length) {
      throw new Error('--oauth and --header are only valid with --url.');
    }
    return {
      transport: 'stdio' as const,
      command: options.command,
      args: options.arg ?? [],
      ...(options.cwd ? { cwd: expandHome(options.cwd) } : {}),
      enabled: !options.disabled,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(tools ? { tools } : {}),
      ...(options.env?.length
        ? { env: Object.fromEntries(options.env.map(parseEnvRefPair)) }
        : {}),
    };
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

function mcpToolPolicy(options: McpAddOptions) {
  const autoApprove = options.autoApprove ?? [];
  const deny = options.deny ?? [];
  if (autoApprove.length === 0 && deny.length === 0) return undefined;
  return {
    ...(autoApprove.length ? { autoApprove } : {}),
    ...(deny.length ? { deny } : {}),
  };
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
