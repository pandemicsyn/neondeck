import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { openDb } from '../lib/sqlite';
import { ensureRuntimeHomeSync, runtimePaths } from '../runtime-home';
import { submitAutopilotFixAction } from '../modules/autopilot/actions/submit-fix';
import {
  autopilotOwnerDiffAction,
  autopilotOwnerFileReadAction,
  autopilotOwnerFileSearchAction,
  autopilotOwnerStatusAction,
} from '../modules/autopilot/owner/actions';
import neonAutopilotFix from '../skills/neon-autopilot-fix/SKILL.md' with { type: 'skill' };
import {
  prAutopilotOwnerCompaction,
  prAutopilotOwnerDurability,
} from '../modules/autopilot/owner/config';
import {
  capabilitySnapshotHash,
  parseStoredCapabilitySnapshot,
  readAutopilotOwnerCapabilitySnapshot,
} from '../modules/autopilot/owner/capabilities';

export { prAutopilotOwnerCompaction, prAutopilotOwnerDurability };

export const description =
  'Private continuing owner for one watched pull request and its managed worktree.';

// Operator inspection is available through the local API-authenticated GET
// surface. Prompt injection over the generated agent route is forbidden.
export const route: AgentRouteHandler = async (context, next) => {
  if (context.req.method === 'GET') return next();
  return context.json(
    { ok: false, error: 'Private autopilot owner prompts are dispatch-only.' },
    403,
  );
};

export default defineAgent(({ id }) => {
  const paths = runtimePaths();
  ensureRuntimeHomeSync(paths);
  const current = readAutopilotOwnerCapabilitySnapshot(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let stored;
  try {
    const row = database
      .prepare(
        `SELECT capability_hash, capability_json
         FROM autopilot_owner_generations WHERE flue_instance_id = ?;`,
      )
      .get(id) as
      { capability_hash?: unknown; capability_json?: unknown } | undefined;
    if (!row || typeof row.capability_hash !== 'string') {
      throw new Error(
        `PR-owner instance ${id} has no durable capability generation.`,
      );
    }
    stored = parseStoredCapabilitySnapshot(row.capability_json);
    if (
      row.capability_hash !== capabilitySnapshotHash(stored) ||
      row.capability_hash !== capabilitySnapshotHash(current)
    ) {
      throw new Error(
        `PR-owner instance ${id} capability drift requires audited rotation.`,
      );
    }
  } finally {
    database.close();
  }
  return {
    model: stored.model,
    thinkingLevel: stored.thinkingLevel,
    cwd: '/workspace',
    compaction: prAutopilotOwnerCompaction,
    durability: prAutopilotOwnerDurability,
    instructions: [
      'You are the private continuing Neondeck owner for exactly one watched pull request.',
      'Each turn begins with a deterministic authoritative envelope. The newest envelope overrides historical transcript facts.',
      'Inspect only the bound managed worktree. You cannot execute a shell, mutate GitHub or config, push, call MCP, delegate, or invoke raw repository mutation actions.',
      'End every actionable turn by calling neondeck_autopilot_submit_fix exactly once. That action alone may apply your scoped proposal and create a prepared diff.',
    ].join('\n\n'),
    skills: [neonAutopilotFix],
    tools: [],
    actions: [
      autopilotOwnerFileReadAction,
      autopilotOwnerFileSearchAction,
      autopilotOwnerDiffAction,
      autopilotOwnerStatusAction,
      submitAutopilotFixAction,
    ],
    subagents: [],
  };
});
