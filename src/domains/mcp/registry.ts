import type { ToolDefinition } from '@flue/runtime';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { subscribeConfigEvents } from '../../config-events';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { runMcpToolThroughGate } from './gate';
import { mcpServerEnabled, type McpServerConfig } from './schemas';
import { readMcpConfig } from './config';
import {
  createMcpOAuthProvider,
  hasMcpOAuthTokens,
  readMcpOAuthStatus,
  type McpOAuthStatus,
} from './oauth';
import { connectSdkMcpServer, type McpSdkConnection } from './stdio';
import {
  deleteMcpToolCatalog,
  listMcpToolCatalog,
  markMcpCatalogUnavailable,
  replaceMcpToolCatalog,
  type McpToolCatalogRecord,
} from './store';

export type McpServerStatus =
  | 'disabled'
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'needs-login'
  | 'error';

export type McpServerSnapshot = {
  id: string;
  transport: 'http' | 'stdio';
  enabled: boolean;
  status: McpServerStatus;
  auth: {
    kind: 'none' | 'header' | 'oauth';
    authorized: boolean;
    expiresAt: string | null;
    scopes: string[];
  };
  toolCount: number;
  message: string;
  lastConnectedAt: string | null;
  lastErrorAt: string | null;
};

type RegistryEntry = {
  status: McpServerStatus;
  message: string;
  connection: McpSdkConnection | null;
  tools: ToolDefinition[];
  catalog: McpToolCatalogRecord[];
  lastConnectedAt: string | null;
  lastErrorAt: string | null;
  refreshPromise: Promise<void> | null;
  pendingServer: McpServerConfig | null;
  refreshGeneration: number;
};

const registries = new Map<string, McpRegistry>();

type McpRegistryPublishTestHookInput = {
  serverId: string;
  tools: ToolDefinition[];
};

type McpRegistryPendingRefreshTestHookInput = {
  serverId: string;
  server: McpServerConfig;
};

let mcpRegistryPublishTestHook:
  ((input: McpRegistryPublishTestHookInput) => Promise<void> | void) | null =
  null;
let mcpRegistryPendingRefreshTestHook:
  | ((input: McpRegistryPendingRefreshTestHookInput) => Promise<void> | void)
  | null = null;

export function setMcpRegistryPublishHookForTests(
  hook:
    ((input: McpRegistryPublishTestHookInput) => Promise<void> | void) | null,
) {
  const previous = mcpRegistryPublishTestHook;
  mcpRegistryPublishTestHook = hook;
  return () => {
    mcpRegistryPublishTestHook = previous;
  };
}

export function setMcpRegistryPendingRefreshHookForTests(
  hook:
    | ((input: McpRegistryPendingRefreshTestHookInput) => Promise<void> | void)
    | null,
) {
  const previous = mcpRegistryPendingRefreshTestHook;
  mcpRegistryPendingRefreshTestHook = hook;
  return () => {
    mcpRegistryPendingRefreshTestHook = previous;
  };
}

export function getMcpRegistry(paths = runtimePaths()) {
  const existing = registries.get(paths.home);
  if (existing) return existing;
  const registry = new McpRegistry(paths);
  registries.set(paths.home, registry);
  return registry;
}

export function mcpAgentToolsSync(paths = runtimePaths()) {
  return getMcpRegistry(paths).toolsSync();
}

export function mcpSnapshotSync(paths = runtimePaths()) {
  return getMcpRegistry(paths).snapshotSync();
}

export class McpRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly paths: RuntimePaths) {}

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeConfigEvents((event) => {
      if (!event.files.includes(this.paths.mcp)) return;
      void this.refresh().catch((error) => {
        console.error('[neondeck] failed to refresh MCP registry', error);
      });
    });
    void this.refresh().catch((error) => {
      console.error('[neondeck] failed to initialize MCP registry', error);
    });
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await Promise.all(
      [...this.entries.values()].map((entry) => entry.connection?.close()),
    );
    this.entries.clear();
  }

  toolsSync() {
    return [...this.entries.values()].flatMap((entry) => entry.tools);
  }

  snapshotSync() {
    return [...this.entries.entries()].map(([id, entry]) => ({
      id,
      status: entry.status,
      message: entry.message,
      toolCount: entry.tools.length,
      lastConnectedAt: entry.lastConnectedAt,
      lastErrorAt: entry.lastErrorAt,
    }));
  }

  async status() {
    const config = await readMcpConfig(this.paths);
    return Promise.all(
      Object.entries(config.servers).map(async ([id, server]) => {
        const entry = this.entries.get(id);
        const auth = await snapshotAuthStatus(id, server, this.paths);
        return {
          id,
          transport: server.transport,
          enabled: mcpServerEnabled(server),
          auth,
          status:
            entry?.status ??
            (mcpServerEnabled(server) ? 'disconnected' : 'disabled'),
          toolCount: entry?.tools.length ?? 0,
          message: entry?.message ?? 'MCP server has not been refreshed.',
          lastConnectedAt: entry?.lastConnectedAt ?? null,
          lastErrorAt: entry?.lastErrorAt ?? null,
        } satisfies McpServerSnapshot;
      }),
    );
  }

  async listTools(serverId?: string) {
    return listMcpToolCatalog(this.paths, { serverId });
  }

  async refresh(serverId?: string) {
    const config = await readMcpConfig(this.paths);
    const configuredIds = new Set(Object.keys(config.servers));

    for (const [id, entry] of this.entries) {
      if (configuredIds.has(id)) continue;
      entry.refreshGeneration += 1;
      entry.pendingServer = null;
      await entry.connection?.close().catch(() => undefined);
      this.entries.delete(id);
    }

    await Promise.all(
      Object.entries(config.servers)
        .filter(([id]) => !serverId || id === serverId)
        .map(([id, server]) => this.refreshOne(id, server)),
    );
  }

  private async refreshOne(id: string, server: McpServerConfig) {
    const current = this.entry(id);
    current.refreshGeneration += 1;
    const generation = current.refreshGeneration;
    if (current.refreshPromise) {
      current.pendingServer = server;
      await mcpRegistryPendingRefreshTestHook?.({ serverId: id, server });
      return current.refreshPromise;
    }

    current.refreshPromise = this.connectOne(id, server, generation).finally(
      async () => {
        current.refreshPromise = null;
        const pendingServer = current.pendingServer;
        current.pendingServer = null;
        if (pendingServer) await this.refreshOne(id, pendingServer);
      },
    );
    return current.refreshPromise;
  }

  private async connectOne(
    id: string,
    server: McpServerConfig,
    generation: number,
  ) {
    const entry = this.entry(id);
    const isCurrent = () => entry.refreshGeneration === generation;
    if (!mcpServerEnabled(server)) {
      const previousConnection = entry.connection;
      await previousConnection?.close().catch(() => undefined);
      if (!isCurrent()) return;
      if (entry.connection === previousConnection) entry.connection = null;
      entry.tools = [];
      entry.status = 'disabled';
      entry.message = 'MCP server is disabled.';
      await markMcpCatalogUnavailable(id, this.paths);
      return;
    }

    const authProvider =
      server.transport === 'http' && server.auth?.kind === 'oauth'
        ? createMcpOAuthProvider({
            paths: this.paths,
            serverId: id,
            server,
          })
        : undefined;

    if (
      server.transport === 'http' &&
      server.auth?.kind === 'oauth' &&
      !(await hasMcpOAuthTokens(id, this.paths))
    ) {
      const previousConnection = entry.connection;
      await previousConnection?.close().catch(() => undefined);
      if (!isCurrent()) return;
      if (entry.connection === previousConnection) entry.connection = null;
      entry.catalog = await cachedCatalog(id, this.paths);
      if (!isCurrent()) return;
      entry.tools = disconnectedTools(id, entry.catalog);
      entry.status = 'needs-login';
      entry.message =
        'OAuth login is required before connecting this MCP server.';
      await markMcpCatalogUnavailable(id, this.paths);
      return;
    }

    if (!isCurrent()) return;
    entry.status = 'connecting';
    entry.message = 'Connecting MCP server.';
    try {
      const previousConnection = entry.connection;
      await previousConnection?.close().catch(() => undefined);
      if (!isCurrent()) return;
      if (entry.connection === previousConnection) entry.connection = null;
      const headers = resolveHeaderAuth(server);
      const connection = await connectSdkMcpServer({
        serverId: id,
        server,
        headers,
        authProvider,
        gate: (input) => runMcpToolThroughGate(input, this.paths),
      });
      if (!isCurrent()) {
        await connection.close().catch(() => undefined);
        return;
      }
      const now = new Date().toISOString();
      const catalog = connection.catalog.map((tool) => ({
        ...tool,
        status: 'available' as const,
        updatedAt: now,
      }));
      await replaceMcpToolCatalog(id, catalog, this.paths);
      if (!isCurrent()) {
        await connection.close().catch(() => undefined);
        await this.clearStaleCatalog(id);
        return;
      }
      await mcpRegistryPublishTestHook?.({
        serverId: id,
        tools: connection.tools,
      });
      entry.connection = connection;
      entry.tools = connection.tools;
      entry.catalog = catalog;
      entry.status = 'connected';
      entry.message = `Connected with ${connection.tools.length} tools.`;
      entry.lastConnectedAt = now;
      entry.lastErrorAt = null;
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      const previousConnection = entry.connection;
      await previousConnection?.close().catch(() => undefined);
      if (!isCurrent()) return;
      if (entry.connection === previousConnection) entry.connection = null;
      await markMcpCatalogUnavailable(id, this.paths);
      entry.catalog =
        entry.catalog.length > 0
          ? entry.catalog
          : await cachedCatalog(id, this.paths);
      entry.tools = disconnectedTools(id, entry.catalog);
      entry.status =
        error instanceof UnauthorizedError ? 'needs-login' : 'error';
      entry.message =
        error instanceof UnauthorizedError
          ? 'OAuth login is required before connecting this MCP server.'
          : message;
      entry.lastErrorAt = new Date().toISOString();
    }
  }

  private entry(id: string) {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const entry: RegistryEntry = {
      status: 'disconnected',
      message: 'MCP server has not connected yet.',
      connection: null,
      tools: [],
      catalog: [],
      lastConnectedAt: null,
      lastErrorAt: null,
      refreshPromise: null,
      pendingServer: null,
      refreshGeneration: 0,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private async clearStaleCatalog(id: string) {
    const config = await readMcpConfig(this.paths).catch(() => null);
    const server = config?.servers[id];
    if (!server) {
      await deleteMcpToolCatalog(id, this.paths);
      return;
    }
    await markMcpCatalogUnavailable(id, this.paths);
  }
}

async function cachedCatalog(serverId: string, paths: RuntimePaths) {
  const catalog = await listMcpToolCatalog(paths, { serverId });
  return catalog.map((tool) => ({ ...tool, status: 'unavailable' as const }));
}

function resolveHeaderAuth(server: McpServerConfig) {
  if (server.transport !== 'http' || server.auth?.kind !== 'header')
    return undefined;
  const headers: Record<string, string> = {};
  for (const [name, ref] of Object.entries(server.auth.headers)) {
    const value = process.env[ref.env];
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

async function snapshotAuthStatus(
  serverId: string,
  server: McpServerConfig,
  paths: RuntimePaths,
): Promise<McpServerSnapshot['auth']> {
  if (server.transport === 'stdio') {
    return { kind: 'none', authorized: true, expiresAt: null, scopes: [] };
  }
  if (server.auth?.kind === 'oauth') {
    const status: McpOAuthStatus = await readMcpOAuthStatus(serverId, paths);
    return {
      kind: 'oauth',
      authorized: status.authorized,
      expiresAt: status.expiresAt,
      scopes: status.scopes,
    };
  }
  return {
    kind: server.auth?.kind ?? 'none',
    authorized: true,
    expiresAt: null,
    scopes: [],
  };
}

function disconnectedTools(serverId: string, catalog: McpToolCatalogRecord[]) {
  return catalog.map((tool) => ({
    name: tool.adaptedName,
    description: `${tool.description} Currently unavailable because MCP server "${serverId}" is disconnected.`,
    input: undefined,
    output: undefined,
    async run() {
      return {
        ok: false,
        status: 'server-disconnected',
        server: serverId,
        tool: tool.toolName,
        untrusted: true,
        message: `MCP server "${serverId}" is disconnected.`,
      };
    },
  })) satisfies ToolDefinition[];
}
