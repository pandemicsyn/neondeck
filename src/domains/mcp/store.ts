import { openDb } from '../../lib/sqlite.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import * as v from 'valibot';
import { stableJson, truncateText } from './format';
import {
  mcpApprovalResolveInputSchema,
  mcpJsonValueSchema,
  type McpExternalValue,
} from './schemas';
import { createApprovalResolutionNudge } from '../../modules/sessions';
import { promoteMcpToolAlways, readMcpConfig } from './config';

export type McpToolCatalogRecord = {
  serverId: string;
  toolName: string;
  adaptedName: string;
  description: string;
  inputSchema: McpExternalValue;
  outputSchema: McpExternalValue;
  annotations: McpExternalValue;
  status: 'available' | 'unavailable';
  updatedAt: string;
};

export type McpApprovalStatus =
  'pending' | 'approved' | 'denied' | 'used' | 'expired';
export type McpApprovalDecision =
  'allow-once' | 'allow-chat' | 'allow-always' | 'deny';

export type McpApprovalRecord = {
  id: string;
  serverId: string;
  toolName: string;
  adaptedName: string;
  argumentsHash: string;
  argumentsPreview: string;
  status: McpApprovalStatus;
  approvalDecision: McpApprovalDecision | null;
  approverSurface: string | null;
  sessionId: string | null;
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
const nullableStringSchema = v.nullable(v.string());
const mcpCatalogRowSchema = v.object({
  server_id: v.string(),
  tool_name: v.string(),
  adapted_name: v.string(),
  description: v.string(),
  input_schema_json: nullableStringSchema,
  output_schema_json: nullableStringSchema,
  annotations_json: nullableStringSchema,
  status: v.picklist(['available', 'unavailable']),
  updated_at: v.string(),
});
const mcpApprovalRowSchema = v.object({
  id: v.string(),
  server_id: v.string(),
  tool_name: v.string(),
  adapted_name: v.string(),
  arguments_hash: v.string(),
  arguments_preview: v.string(),
  status: v.picklist(['pending', 'approved', 'denied', 'used', 'expired']),
  approval_decision: v.nullable(
    v.picklist(['allow-once', 'allow-chat', 'allow-always', 'deny']),
  ),
  approver_surface: nullableStringSchema,
  expires_at: v.string(),
  created_at: v.string(),
  resolved_at: nullableStringSchema,
  used_at: nullableStringSchema,
  session_id: v.optional(nullableStringSchema),
  updated_at: v.string(),
});
const mcpAuditRowSchema = v.object({
  id: v.string(),
  server_id: v.string(),
  tool_name: v.string(),
  adapted_name: v.string(),
  arguments_hash: v.string(),
  decision: v.string(),
  approval_id: nullableStringSchema,
  duration_ms: v.nullable(v.number()),
  ok: v.picklist([0, 1]),
  result_preview: nullableStringSchema,
  error: nullableStringSchema,
  created_at: v.string(),
});

type McpCatalogRow = v.InferOutput<typeof mcpCatalogRowSchema>;
type McpApprovalRow = v.InferOutput<typeof mcpApprovalRowSchema>;
type McpAuditRow = v.InferOutput<typeof mcpAuditRowSchema>;

type McpCatalogReplaceTestHookInput = {
  serverId: string;
  records: McpToolCatalogRecord[];
  paths: RuntimePaths;
};

let mcpCatalogReplaceTestHook:
  ((input: McpCatalogReplaceTestHookInput) => Promise<void> | void) | null =
  null;

export function setMcpCatalogReplaceHookForTests(
  hook:
    ((input: McpCatalogReplaceTestHookInput) => Promise<void> | void) | null,
) {
  const previous = mcpCatalogReplaceTestHook;
  mcpCatalogReplaceTestHook = hook;
  return () => {
    mcpCatalogReplaceTestHook = previous;
  };
}

export function hashMcpArguments(value: McpExternalValue) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export async function replaceMcpToolCatalog(
  serverId: string,
  records: McpToolCatalogRecord[],
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  await mcpCatalogReplaceTestHook?.({ serverId, records, paths });
  const database = openDb(paths.neondeckDatabase);
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
  const database = openDb(paths.neondeckDatabase);
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

export async function deleteMcpToolCatalog(
  serverId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM mcp_tool_catalog WHERE server_id = ?;')
      .run(serverId);
  } finally {
    database.close();
  }
}

export async function listMcpToolCatalog(
  paths = runtimePaths(),
  options: { serverId?: string } = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
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
    ).flatMap((row) => {
      const parsed = v.safeParse(mcpCatalogRowSchema, row);
      return parsed.success ? [parsed.output] : [];
    });
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
    sessionId?: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    const sessionId = nonEmpty(input.sessionId);
    const chatRow = sessionId
      ? optionalApprovalRow(
          database
            .prepare(
              `
            SELECT *
            FROM mcp_tool_approvals
            WHERE server_id = ?
              AND tool_name = ?
              AND adapted_name = ?
              AND session_id = ?
              AND status = 'approved'
              AND approval_decision = 'allow-chat'
            ORDER BY resolved_at DESC
            LIMIT 1;
          `,
            )
            .get(input.serverId, input.toolName, input.adaptedName, sessionId),
        )
      : undefined;
    if (chatRow) return readApprovalRow(chatRow);

    const row = optionalApprovalRow(
      database
        .prepare(
          `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND status = 'approved'
          AND approval_decision = 'allow-once'
          AND COALESCE(session_id, '') = ?
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
          nonEmpty(input.sessionId) ?? '',
          new Date().toISOString(),
        ),
    );
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
    sessionId?: string;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    const sessionId = nonEmpty(input.sessionId);
    const chatRow = sessionId
      ? optionalApprovalRow(
          database
            .prepare(
              `
            SELECT *
            FROM mcp_tool_approvals
            WHERE server_id = ?
              AND tool_name = ?
              AND adapted_name = ?
              AND session_id = ?
              AND status = 'approved'
              AND approval_decision = 'allow-chat'
            ORDER BY resolved_at DESC
            LIMIT 1;
          `,
            )
            .get(input.serverId, input.toolName, input.adaptedName, sessionId),
        )
      : undefined;
    if (chatRow) {
      database.exec('COMMIT;');
      transactionStarted = false;
      return readApprovalRow(chatRow);
    }
    const row = optionalApprovalRow(
      database
        .prepare(
          `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND status = 'approved'
          AND approval_decision = 'allow-once'
          AND COALESCE(session_id, '') = ?
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
          sessionId ?? '',
          now,
        ),
    );
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
    sessionId?: string | null;
    ttlMs?: number;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  expireOldApprovals(paths);
  const database = openDb(paths.neondeckDatabase);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? defaultApprovalTtlMs),
  ).toISOString();
  const sessionId = nonEmpty(input.sessionId);

  try {
    const existing = optionalApprovalRow(
      database
        .prepare(
          `
        SELECT *
        FROM mcp_tool_approvals
        WHERE server_id = ?
          AND tool_name = ?
          AND adapted_name = ?
          AND arguments_hash = ?
          AND COALESCE(session_id, '') = ?
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
          sessionId ?? '',
          nowIso,
        ),
    );
    if (existing) {
      return readApprovalRow(existing);
    }

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
          approval_decision,
          approver_surface,
          session_id,
          expires_at,
          created_at,
          resolved_at,
          used_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, NULL, NULL, ?);
      `,
      )
      .run(
        id,
        input.serverId,
        input.toolName,
        input.adaptedName,
        input.argumentsHash,
        truncateText(input.argumentsPreview, 4000),
        sessionId ?? null,
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
  const database = openDb(paths.neondeckDatabase);
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

export async function resolveMcpApproval(rawInput: McpExternalValue) {
  const paths = runtimePaths();
  return resolveMcpApprovalWithPaths(rawInput, paths);
}

export async function resolveMcpApprovalWithPaths(
  rawInput: McpExternalValue,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(mcpApprovalResolveInputSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'mcp_approval_resolve',
      changed: false,
      message: `Invalid MCP approval resolution input: ${v.summarize(parsed.issues)}`,
      requires: ['id', 'decision'],
    };
  }
  const input = parsed.output;
  expireOldApprovals(paths);
  const nextStatus = input.decision === 'deny' ? 'denied' : 'approved';
  const preflight = readApproval(paths, input.id);
  if (!preflight) {
    return {
      ok: false,
      action: 'mcp_approval_resolve',
      changed: false,
      message: `MCP approval "${input.id}" was not found.`,
      requires: ['id'],
    };
  }
  if (preflight.status !== 'pending') {
    return {
      ok: false,
      action: 'mcp_approval_resolve',
      changed: false,
      message: `MCP approval "${input.id}" is already ${preflight.status}.`,
      approval: preflight,
    };
  }

  if (input.decision === 'allow-chat') {
    if (!preflight.sessionId) {
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message:
          'This MCP approval is not linked to a chat, so it cannot be allowed for this chat.',
        requires: ['sessionId'],
        approval: preflight,
      };
    }
  }

  let resolutionClaim: string | null = null;
  if (input.decision === 'allow-always') {
    resolutionClaim = `resolving:${randomUUID()}`;
    if (!claimMcpApprovalResolution(paths, input.id, resolutionClaim)) {
      const current = readApproval(paths, input.id);
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: current
          ? `MCP approval "${input.id}" is already being resolved.`
          : `MCP approval "${input.id}" was not found.`,
        ...(current ? { approval: current } : { requires: ['id'] }),
      };
    }
    let promoted: Awaited<ReturnType<typeof promoteMcpToolAlways>>;
    try {
      promoted = await promoteMcpToolAlways(
        {
          serverId: preflight.serverId,
          toolName: preflight.toolName,
          preserveApprovalId: preflight.id,
        },
        paths,
      );
    } catch (error) {
      const config = await readMcpConfig(paths).catch(() => null);
      const persisted =
        config?.servers[preflight.serverId]?.tools?.overrides?.[
          preflight.toolName
        ] === 'approve';
      if (!persisted) {
        releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
        throw error;
      }
      promoted = {
        ok: true,
        action: 'mcp_server_update',
        changed: true,
        message: `Always-allow policy for MCP tool "${preflight.toolName}" was persisted before ancillary config recording failed.`,
        home: paths.home,
        files: [paths.mcp],
      };
    }
    if (!promoted.ok) {
      releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
      return promoted;
    }
  }
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    const existingRow = optionalApprovalRow(
      database
        .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
        .get(input.id),
    );
    if (!existingRow) {
      database.exec('COMMIT;');
      transactionStarted = false;
      if (resolutionClaim) {
        releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
      }
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: `MCP approval "${input.id}" was not found.`,
        requires: ['id'],
      };
    }

    const existing = readApprovalRow(existingRow);
    if (
      existingRow.approver_surface?.startsWith('resolving:') &&
      existingRow.approver_surface !== resolutionClaim
    ) {
      database.exec('COMMIT;');
      transactionStarted = false;
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: `MCP approval "${input.id}" is already being resolved.`,
        approval: existing,
      };
    }
    if (existing.status !== 'pending') {
      database.exec('COMMIT;');
      transactionStarted = false;
      if (resolutionClaim) {
        releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
      }
      return {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: `MCP approval "${input.id}" is already ${existing.status}.`,
        approval: existing,
      };
    }

    const updateResult = database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = ?,
            approval_decision = ?,
            approver_surface = ?,
            resolved_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'pending'
          ${resolutionClaim ? 'AND approver_surface = ?' : "AND COALESCE(approver_surface, '') NOT LIKE 'resolving:%'"};
      `,
      )
      .run(
        nextStatus,
        input.decision,
        input.approverSurface ?? 'unknown',
        now,
        now,
        input.id,
        ...(resolutionClaim ? [resolutionClaim] : []),
      );

    if (updateResult.changes !== 1) {
      const currentRow = optionalApprovalRow(
        database
          .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
          .get(input.id),
      );
      const current = currentRow ? readApprovalRow(currentRow) : null;
      database.exec('COMMIT;');
      transactionStarted = false;
      if (resolutionClaim) {
        releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
      }
      const response = {
        ok: false,
        action: 'mcp_approval_resolve',
        changed: false,
        message: current
          ? `MCP approval "${input.id}" is already ${current.status}.`
          : `MCP approval "${input.id}" was not found.`,
      };
      if (current) return { ...response, approval: current };
      return { ...response, requires: ['id'] };
    }

    const approval = readApprovalRow({
      ...existingRow,
      status: nextStatus,
      approval_decision: input.decision,
      approver_surface: input.approverSurface ?? 'unknown',
      resolved_at: now,
      updated_at: now,
    });
    database.exec('COMMIT;');
    transactionStarted = false;
    const nudge = await createApprovalResolutionNudge(
      {
        family: 'mcp',
        sessionId: approval.sessionId,
        approvalId: approval.id,
        decision: nextStatus === 'approved' ? 'approved' : 'denied',
        subject: `${approval.serverId}/${approval.adaptedName}`,
        retryInstruction:
          input.decision === 'allow-once'
            ? 'Retry the same MCP tool call with the same arguments.'
            : 'Retry the MCP tool call. This grant is not bound to the previous arguments.',
      },
      paths,
    );
    const nudgeErrors = nudge.ok ? [] : nudge.errors;
    const response = {
      ok: true,
      action: 'mcp_approval_resolve',
      changed: true,
      message:
        nextStatus === 'approved'
          ? input.decision === 'allow-once'
            ? `Allowed MCP tool call "${input.id}" once. Retry it with the same arguments.`
            : input.decision === 'allow-chat'
              ? `Allowed MCP tool "${approval.toolName}" for this chat. Retry the tool call.`
              : `Always allowed MCP tool "${approval.toolName}" on server "${approval.serverId}". Retry the tool call.`
          : `Denied MCP tool call "${input.id}".`,
      approval,
    };
    if (nudgeErrors.length === 0) return response;
    return {
      ...response,
      requires: ['approvalNudge'],
      errors: nudgeErrors,
    };
  } catch (error) {
    if (transactionStarted) database.exec('ROLLBACK;');
    if (resolutionClaim) {
      releaseMcpApprovalResolution(paths, input.id, resolutionClaim);
    }
    throw error;
  } finally {
    database.close();
  }
}

function claimMcpApprovalResolution(
  paths: RuntimePaths,
  id: string,
  claimedSurface: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const result = database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET approver_surface = ?, updated_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND COALESCE(approver_surface, '') NOT LIKE 'resolving:%';
      `,
      )
      .run(claimedSurface, new Date().toISOString(), id);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

function releaseMcpApprovalResolution(
  paths: RuntimePaths,
  id: string,
  claimedSurface: string,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET approver_surface = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND approver_surface = ?;
      `,
      )
      .run(new Date().toISOString(), id, claimedSurface);
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
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
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
      .all()
      .flatMap((row) => {
        const parsed = v.safeParse(mcpApprovalRowSchema, row);
        return parsed.success ? [parsed.output] : [];
      });
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
  const database = openDb(paths.neondeckDatabase);
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
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
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
    ).flatMap((row) => {
      const parsed = v.safeParse(mcpAuditRowSchema, row);
      return parsed.success ? [parsed.output] : [];
    });
    return rows.map(readAuditRow);
  } finally {
    database.close();
  }
}

function readApproval(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = optionalApprovalRow(
      database
        .prepare('SELECT * FROM mcp_tool_approvals WHERE id = ?;')
        .get(id),
    );
    return row ? readApprovalRow(row) : null;
  } finally {
    database.close();
  }
}

function expireOldApprovals(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = 'expired',
            updated_at = ?
        WHERE status IN ('pending', 'approved')
          AND COALESCE(approval_decision, '') NOT IN ('allow-chat', 'allow-always')
          AND expires_at <= ?;
      `,
      )
      .run(now, now);
  } finally {
    database.close();
  }
}

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
    approvalDecision: row.approval_decision,
    approverSurface: row.approver_surface,
    sessionId: nonEmpty(row.session_id) ?? null,
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
    return v.parse(mcpJsonValueSchema, JSON.parse(value));
  } catch {
    return null;
  }
}

function optionalApprovalRow(value: McpExternalValue) {
  const parsed = v.safeParse(mcpApprovalRowSchema, value);
  return parsed.success ? parsed.output : undefined;
}

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
