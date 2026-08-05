import { openDb } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';

export async function expireMcpServerApprovals(
  serverId: string,
  paths = runtimePaths(),
  options: { exceptId?: string } = {},
) {
  await ensureRuntimeHome(paths);
  expireMcpServerApprovalsSync(serverId, paths, options);
}

export function expireMcpServerApprovalsSync(
  serverId: string,
  paths: RuntimePaths = runtimePaths(),
  options: { exceptId?: string } = {},
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE mcp_tool_approvals
        SET status = 'expired',
            updated_at = ?
        WHERE server_id = ?
          AND id <> ?
          AND COALESCE(approver_surface, '') NOT LIKE 'resolving:%'
          AND status IN ('pending', 'approved');
      `,
      )
      .run(now, serverId, options.exceptId ?? '');
  } finally {
    database.close();
  }
}
