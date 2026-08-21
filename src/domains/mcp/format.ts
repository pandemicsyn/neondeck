import * as v from 'valibot';
import {
  mcpExternalRecordSchema,
  type McpExternalValue,
  type McpServerConfig,
} from './schemas';

export function adaptedMcpToolName(serverId: string, toolName: string) {
  return `mcp__${sanitizeMcpNamePart(serverId)}__${sanitizeMcpNamePart(toolName)}`;
}

export function sanitizeMcpNamePart(value: string) {
  return (
    value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'unnamed'
  );
}

export function mcpServerLabel(id: string, server: McpServerConfig) {
  if (server.transport === 'http') return `${id} (http)`;
  return `${id} (stdio)`;
}

export function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function stableJson(value: McpExternalValue) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: McpExternalValue): McpExternalValue {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = v.safeParse(mcpExternalRecordSchema, value);
  if (!record.success) return value;
  return Object.fromEntries(
    Object.entries(record.output)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
