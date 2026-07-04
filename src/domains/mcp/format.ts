import type { McpServerConfig } from './schemas';

export function adaptedMcpToolName(serverId: string, toolName: string) {
  return `mcp__${sanitizeMcpNamePart(serverId)}__${sanitizeMcpNamePart(toolName)}`;
}

export function sanitizeMcpNamePart(value: string) {
  return (
    value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed'
  );
}

export function mcpServerLabel(id: string, server: McpServerConfig) {
  if (server.transport === 'http')
    return `${id} (${server.sse ? 'sse' : 'http'})`;
  return `${id} (stdio)`;
}

export function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
