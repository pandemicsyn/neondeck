import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { stableJson, truncateText } from './format';

export type McpToolCatalogRecord = {
  serverId: string;
  toolName: string;
  adaptedName: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
  status: 'available' | 'unavailable';
  updatedAt: string;
};

export type McpApprovalStatus =
  'pending' | 'approved' | 'denied' | 'used' | 'expired';

export type McpApprovalRecord = {
  id: string;
  serverId: string;
  toolName: string;
  adaptedName: string;
  argumentsHash: string;
  argumentsPreview: string;
  status: McpApprovalStatus;
  approverSurface: string | null;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
  usedAt: string | null;
  updatedAt: string;
};

export type McpAuditRecord = {
  id: string;
  serverId: string;
  toolName: string;
  adaptedName: string;
  argumentsHash: string;
  decision: string;
  approvalId: string | null;
  durationMs: number | null;
  ok: boolean;
  resultPreview: string | null;
  error: string | null;
  createdAt: string;
};

const defaultApprovalTtlMs = 15 * 60 * 1000;

export function hashMcpArguments(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function replaceMcpToolCatalog(
  serverId: string,
  records: McpToolCatalogRecord[],
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();

  try {
    const statement = database.prepare(
      `
            INSERT INTO mcp_tool_catalog (
              server_id,
              tool_name,
              adapted_name,
              description,
              input_schema_json,
              output_schema_json,
              annotations_json,
              status,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(server_id, tool_name) DO UPDATE SET
              adapted_name = excluded.adapted_name,
              description = excluded.description,
              input_schema_json = excluded.input_schema_json,
              output_schema_json = excluded.output_schema_json,
              annotations_json = excluded.annotations_json,
              status = excluded.status,
              updated_at = excluded.updated_at;
          `,
    );
    for (const item of records) {
      statement.run(
        item.serverId,
        item.toolName,
        item.adaptedName,
        truncateText(item.description, 1200),
        JSON.stringify(item.inputSchema ?? null),
        JSON.stringify(item.outputSchema ?? null),
        JSON.stringify(item.annotations ?? null),
        item.status,
        item.updatedAt || now,
      );
    }
    if (records.length === 0) {
      database
        .prepare(
          `
          UPDATE mcp_tool_catalog
          SET status = 'unavailable',
              updated_at = ?
          WHERE server_id = ?;
        `,
        )
        .run(now, serverId);
    } else {
      const toolNames = records.map((item) => item.toolName);
      const placeholders = toolNames.map(() => '?').join(', ');
      database
        .prepare(
          `
          UPDATE mcp_tool_catalog
          SET status = 'unavailable',
              updated_at = ?
          WHERE server_id = ?
            AND tool_name NOT IN (${placeholders});
        `,
        )
        .run(now, serverId, ...toolNames);
    }
  } finally {
    database.close();
  }
}

export async function markMcpCatalogUnavailable(
  serverId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_catalog
        SET status = 'unavailable',
            updated_at = ?
        WHERE server_id = ?;
      `,
      )
      .run(new Date().toISOString(), serverId);
  } finally {
    database.close();
  }
}

export async function listMcpToolCatalog(
  paths = runtimePaths(),
  options: { serverId?: string } = {},
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = (
      options.serverId
        ? database
            .prepare(
              `
              SELECT *
              FROM mcp_tool_catalog
              WHERE server_id = ?
              ORDER BY server_id, tool_name;
            `,
            )
            .all(options.serverId)
        : database
            .prepare(
              `
              SELECT *
              FROM mcp_tool_catalog
              ORDER BY server_id, tool_name;
            `,
            )
            .all()
    ) as McpCatalogRow[];
    return rows.map(readCatalogRow);
  } finally {
    database.close();
  }
}

export async function findUsableMcpApproval(
  input: {
    serverId: string;
    toolName: string;
    adaptedName: string;
    argumentsHash: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND status = 'approved'
          AND expires_at > ?
        ORDER BY resolved_at ASC
        LIMIT 1;
      `,
      )
      .get(
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        new Date().toISOString(),
      ) as McpApprovalRow | undefined;
    return row ? readApprovalRow(row) : null;
  } finally {
    database.close();
  }
}

export async function consumeUsableMcpApproval(
  input: {
    serverId: string;
    toolName: string;
    adaptedName: string;
    argumentsHash: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    const row = database
      .prepare(
        `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND status = 'approved'
          AND expires_at > ?
        ORDER BY resolved_at ASC
        LIMIT 1;
      `,
      )
      .get(
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        now,
      ) as McpApprovalRow | undefined;
    if (!row) {
      database.exec('COMMIT;');
      return null;
    }

    const result = database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = 'used',
            used_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'approved';
      `,
      )
      .run(now, now, row.id);
    database.exec('COMMIT;');
    transactionStarted = false;
    return result.changes === 1
      ? readApprovalRow({
          ...row,
          status: 'used',
          used_at: now,
          updated_at: now,
        })
      : null;
  } catch (error) {
    if (transactionStarted) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function createMcpApprovalRequest(
  input: {
    serverId: string;
    toolName: string;
    adaptedName: string;
    argumentsHash: string;
    argumentsPreview: string;
    ttlMs?: number;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? defaultApprovalTtlMs),
  ).toISOString();

  try {
    const existing = database
      .prepare(
        `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND status = 'pending'
          AND expires_at > ?
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        nowIso,
      ) as McpApprovalRow | undefined;
    if (existing) return readApprovalRow(existing);

    const id = randomUUID();
    database
      .prepare(
        `
        INSERT INTO mcp_tool_approvals (
          id,
          server_id,
          tool_name,
          adapted_name,
          arguments_hash,
          arguments_preview,
          status,
          approver_surface,
          expires_at,
          created_at,
          resolved_at,
          used_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL, ?);
      `,
      )
      .run(
        id,
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        truncateText(input.argumentsPreview, 4000),
        expiresAt,
        nowIso,
        nowIso,
      );
    return readApproval(paths, id);
  } finally {
    database.close();
  }
}

export async function consumeMcpApproval(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = 'used',
            used_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'approved';
      `,
      )
      .run(now, now, id);
  } finally {
    database.close();
  }
}

export async function resolveMcpApproval(rawInput: {
  id: string;
  decision: 'approve' | 'deny';
  approverSurface?: string;
}) {
  const paths = runtimePaths();
  return resolveMcpApprovalWithPaths(rawInput, paths);
}

export async function resolveMcpApprovalWithPaths(
  rawInput: {
    id: string;
    decision: 'approve' | 'deny';
    approverSurface?: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const nextStatus = rawInput.decision === 'approve' ? 'approved' : 'denied';
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    const existingRow = database
      .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
      .get(rawInput.id) as McpApprovalRow | undefined;
    if (!existingRow) {
      database.exec('COMMIT;');
      transactionStarted = false;
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: `MCP approval "${rawInput.id}" was not found.`,
        requires: ['id'],
      };
    }

    const existing = readApprovalRow(existingRow);
    if (existing.status !== 'pending') {
      database.exec('COMMIT;');
      transactionStarted = false;
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: `MCP approval "${rawInput.id}" is already ${existing.status}.`,
        approval: existing,
      };
    }

    const result = database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = ?,
            approver_surface = ?,
            resolved_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'pending';
      `,
      )
      .run(
        nextStatus,
        rawInput.approverSurface ?? 'unknown',
        now,
        now,
        rawInput.id,
      );

    if (result.changes !== 1) {
      const currentRow = database
        .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
        .get(rawInput.id) as McpApprovalRow | undefined;
      const current = currentRow ? readApprovalRow(currentRow) : null;
      database.exec('COMMIT;');
      transactionStarted = false;
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: current
          ? `MCP approval "${rawInput.id}" is already ${current.status}.`
          : `MCP approval "${rawInput.id}" was not found.`,
        ...(current ? { approval: current } : { requires: ['id'] }),
      };
    }

    const approval = readApprovalRow({
      ...existingRow,
      status: nextStatus,
      approver_surface: rawInput.approverSurface ?? 'unknown',
      resolved_at: now,
      updated_at: now,
    });
    database.exec('COMMIT;');
    transactionStarted = false;
    return {
      ok: true,
      action: 'mcp_approval_resolve',
      changed: true,
      message:
        nextStatus === 'approved'
          ? `Approved MCP tool call "${rawInput.id}". Retry the same tool call with the same arguments.`
          : `Denied MCP tool call "${rawInput.id}".`,
      approval,
    };
  } catch (error) {
    if (transactionStarted) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function listMcpApprovals(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `
        SELECT *
        FROM mcp_tool_approvals
        ${options.includeResolved ? '' : "WHERE status = 'pending'"}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100;
      `,
      )
      .all() as McpApprovalRow[];
    return rows.map(readApprovalRow);
  } finally {
    database.close();
  }
}

export async function insertMcpAudit(
  input: {
    serverId: string;
    toolName: string;
    adaptedName: string;
    argumentsHash: string;
    decision: string;
    approvalId?: string | null;
    durationMs?: number | null;
    ok: boolean;
    resultPreview?: string | null;
    error?: string | null;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        INSERT INTO mcp_tool_audit (
          id,
          server_id,
          tool_name,
          adapted_name,
          arguments_hash,
          decision,
          approval_id,
          duration_ms,
          ok,
          result_preview,
          error,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        id,
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        input.decision,
        input.approvalId ?? null,
        input.durationMs ?? null,
        input.ok ? 1 : 0,
        input.resultPreview ? truncateText(input.resultPreview, 4000) : null,
        input.error ? truncateText(input.error, 4000) : null,
        now,
      );
  } finally {
    database.close();
  }
}

export async function listMcpAudit(
  paths = runtimePaths(),
  options: { serverId?: string; limit?: number } = {},
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  try {
    const rows = (
      options.serverId
        ? database
            .prepare(
              `
              SELECT *
              FROM mcp_tool_audit
              WHERE server_id = ?
              ORDER BY created_at DESC
              LIMIT ?;
            `,
            )
            .all(options.serverId, limit)
        : database
            .prepare(
              `
              SELECT *
              FROM mcp_tool_audit
              ORDER BY created_at DESC
              LIMIT ?;
            `,
            )
            .all(limit)
    ) as McpAuditRow[];
    return rows.map(readAuditRow);
  } finally {
    database.close();
  }
}

function readApproval(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
      .get(id) as McpApprovalRow | undefined;
    return row ? readApprovalRow(row) : null;
  } finally {
    database.close();
  }
}

function expireOldApprovals(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = 'expired',
            updated_at = ?
        WHERE status = 'pending'
          AND expires_at <= ?;
      `,
      )
      .run(now, now);
  } finally {
    database.close();
  }
}

type McpCatalogRow = {
  server_id: string;
  tool_name: string;
  adapted_name: string;
  description: string;
  input_schema_json: string | null;
  output_schema_json: string | null;
  annotations_json: string | null;
  status: 'available' | 'unavailable';
  updated_at: string;
};

type McpApprovalRow = {
  id: string;
  server_id: string;
  tool_name: string;
  adapted_name: string;
  arguments_hash: string;
  arguments_preview: string;
  status: McpApprovalStatus;
  approver_surface: string | null;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  used_at: string | null;
  updated_at: string;
};

type McpAuditRow = {
  id: string;
  server_id: string;
  tool_name: string;
  adapted_name: string;
  arguments_hash: string;
  decision: string;
  approval_id: string | null;
  duration_ms: number | null;
  ok: 0 | 1;
  result_preview: string | null;
  error: string | null;
  created_at: string;
};

function readCatalogRow(row: McpCatalogRow): McpToolCatalogRecord {
  return {
    serverId: row.server_id,
    toolName: row.tool_name,
    adaptedName: row.adapted_name,
    description: row.description,
    inputSchema: parseJson(row.input_schema_json),
    outputSchema: parseJson(row.output_schema_json),
    annotations: parseJson(row.annotations_json),
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function readApprovalRow(row: McpApprovalRow): McpApprovalRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    toolName: row.tool_name,
    adaptedName: row.adapted_name,
    argumentsHash: row.arguments_hash,
    argumentsPreview: row.arguments_preview,
    status: row.status,
    approverSurface: row.approver_surface,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    usedAt: row.used_at,
    updatedAt: row.updated_at,
  };
}

function readAuditRow(row: McpAuditRow): McpAuditRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    toolName: row.tool_name,
    adaptedName: row.adapted_name,
    argumentsHash: row.arguments_hash,
    decision: row.decision,
    approvalId: row.approval_id,
    durationMs: row.duration_ms,
    ok: row.ok === 1,
    resultPreview: row.result_preview,
    error: row.error,
    createdAt: row.created_at,
  };
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
