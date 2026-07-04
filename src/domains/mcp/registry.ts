import type { ToolDefinition } from '@flue/runtime';
import { subscribeConfigEvents } from '../../config-events';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { runMcpToolThroughGate } from './gate';
import { mcpServerEnabled, type McpServerConfig } from './schemas';
import { readMcpConfig } from './config';
import { connectSdkMcpServer, type McpSdkConnection } from './stdio';
import {
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
};

const registries = new Map<string, McpRegistry>();

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
    await this.refresh();
    const config = await readMcpConfig(this.paths);
    return Object.entries(config.servers).map(([id, server]) => {
      const entry = this.entries.get(id);
      return {
        id,
        transport: server.transport,
        enabled: mcpServerEnabled(server),
        status:
          entry?.status ??
          (mcpServerEnabled(server) ? 'disconnected' : 'disabled'),
        toolCount: entry?.tools.length ?? 0,
        message: entry?.message ?? 'MCP server has not been refreshed.',
        lastConnectedAt: entry?.lastConnectedAt ?? null,
        lastErrorAt: entry?.lastErrorAt ?? null,
      } satisfies McpServerSnapshot;
    });
  }

  async listTools(serverId?: string) {
    await this.refresh();
    return listMcpToolCatalog(this.paths, { serverId });
  }

  async refresh(serverId?: string) {
    const config = await readMcpConfig(this.paths);
    const configuredIds = new Set(Object.keys(config.servers));

    for (const [id, entry] of this.entries) {
      if (configuredIds.has(id)) continue;
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
    if (current.refreshPromise) return current.refreshPromise;

    current.refreshPromise = this.connectOne(id, server).finally(() => {
      current.refreshPromise = null;
    });
    return current.refreshPromise;
  }

  private async connectOne(id: string, server: McpServerConfig) {
    const entry = this.entry(id);
    if (!mcpServerEnabled(server)) {
      await entry.connection?.close().catch(() => undefined);
      entry.connection = null;
      entry.tools = [];
      entry.status = 'disabled';
      entry.message = 'MCP server is disabled.';
      await markMcpCatalogUnavailable(id, this.paths);
      return;
    }

    if (server.transport === 'http' && server.auth?.kind === 'oauth') {
      await entry.connection?.close().catch(() => undefined);
      entry.connection = null;
      entry.tools = [];
      entry.status = 'needs-login';
      entry.message =
        'OAuth login is required before connecting this MCP server.';
      await markMcpCatalogUnavailable(id, this.paths);
      return;
    }

    entry.status = 'connecting';
    entry.message = 'Connecting MCP server.';
    try {
      await entry.connection?.close().catch(() => undefined);
      const headers = resolveHeaderAuth(server);
      const connection = await connectSdkMcpServer({
        serverId: id,
        server,
        headers,
        gate: (input) => runMcpToolThroughGate(input, this.paths),
      });
      const now = new Date().toISOString();
      const catalog = connection.catalog.map((tool) => ({
        ...tool,
        status: 'available' as const,
        updatedAt: now,
      }));
      await replaceMcpToolCatalog(catalog, this.paths);
      entry.connection = connection;
      entry.tools = connection.tools;
      entry.catalog = catalog;
      entry.status = 'connected';
      entry.message = `Connected with ${connection.tools.length} tools.`;
      entry.lastConnectedAt = now;
      entry.lastErrorAt = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await entry.connection?.close().catch(() => undefined);
      entry.connection = null;
      entry.tools = disconnectedTools(id, entry.catalog);
      entry.status = 'error';
      entry.message = message;
      entry.lastErrorAt = new Date().toISOString();
      await markMcpCatalogUnavailable(id, this.paths);
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
    };
    this.entries.set(id, entry);
    return entry;
  }
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
