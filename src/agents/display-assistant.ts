'use agent';

import {
  bash,
  type AgentProps,
  useAgentStart,
  useDataWriter,
  useDelivery,
  useModel,
  usePersistentState,
  useResponseStart,
  useSandbox,
  useSkill,
  useSubagent,
  useTool,
} from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import { Bash, InMemoryFs } from 'just-bash';
import { createHash } from 'node:crypto';
import {
  readAgentModelSelectionSync,
  runtimeSkillFromSessionSnapshot,
  runtimeSkillSessionSnapshotsSync,
  type AgentModelSelection,
  type RuntimeSkillSessionSnapshot,
} from '../modules/runtime';
import {
  type BriefingDisplayContextBinding,
  briefingClientDataSchema,
  neondeckBriefingActions,
  prepareBriefingAgentDelivery,
  attachBriefingContextSnapshot,
  readBriefingContextBindingSync,
} from '../modules/briefings';
import { neondeckCommandActions } from '../modules/commands';
import { neondeckConfigActions } from '../modules/config';
import { neondeckDevDoctorActions } from '../modules/runtime';
import { neondeckExeDevCheckoutActions } from '../modules/execution';
import { neondeckExecutionActions } from '../modules/execution';
import { executionPolicyCheckAction } from '../modules/execution';
import { neondeckKiloActions } from '../modules/kilo';
import { neondeckKiloResultActions } from '../modules/kilo/results';
import { neondeckLearningOperatorActions } from '../modules/learning';
import {
  mcpAgentToolsForSessionSync,
  mcpInstructionsSync,
  mcpToolSessionSnapshotsSync,
  neondeckMcpActions,
  type McpToolSessionSnapshot,
} from '../domains/mcp';
import { neondeckMemoryActions } from '../modules/memory';
import { neondeckPrEventActions } from '../modules/pr-events';
import { neondeckReviewSurfaceActions } from '../modules/review-surfaces';
import { neondeckRuntimeSkillActions } from '../modules/runtime';
import { neondeckSkillPatchActions } from '../modules/learning/skill-patches';
import { neondeckRepoEditActions, neondeckRepoReadActions } from '../repo-edit';
import { neondeckSchedulerActions } from '../modules/scheduler';
import { neondeckScheduledTaskActions } from '../modules/scheduled-tasks';
import {
  neondeckSessionActions,
  displaySessionContextSnapshotForAgentSync,
  recordDisplaySessionContextSnapshotSync,
} from '../modules/sessions';
import { soulInstructions } from '../modules/runtime';
import { neondeckSubagents } from '../modules/runtime';
import { neondeckFactTools } from './support/tools';
import {
  displayAssistantAutopilotActions,
  displayAssistantAutopilotInstructions,
} from './support/autopilot';
import { neondeckWatchActions } from '../modules/watches';
import { neondeckWorktreeActions } from '../modules/worktrees';
import githubGh from '../skills/github-gh/SKILL.md';
import neondeck from '../skills/neondeck/SKILL.md';

export const description =
  'Persistent assistant for the neondeck companion dashboard.';

export const displayAssistantDelegationInstructions =
  'Delegate focused research to subagents when it will improve accuracy, but pass a complete self-contained task because delegates do not inherit this conversation. Use explore for focused read-only repository inspection through its configured repo tools, repo_researcher for supplied repo context, ci_investigator for supplied checks and validation facts, and release_reviewer for supplied release/watch readiness facts. When two or more Explore investigations are independent, give each a distinct focus and launch up to three Explore task calls together in one tool-call batch so they run concurrently. Use one task when the scope is narrow or a later investigation depends on an earlier result. A concurrent delegation batch may contain only independent task calls: never batch a task call with a mutation or external-action tool, and wait for every delegate to finish before evaluating their evidence and taking any action. Gather deterministic GitHub, CI, watch, and runtime facts yourself before delegating; do not ask subagents to discover host tools or run raw bash for those facts.';

export const route: MiddlewareHandler = async (_c, next) => next();

type DisplayAssistantSessionContext = {
  version: 2;
  snapshotId: string;
  capturedAt: string;
  baselineSnapshotId: string | null;
  baselineLoadedAt: string;
  sessionContextFence: string;
  configHistoryId: number;
  memoryEventSequence: number;
  pendingBriefingRunId: string | null;
  models: AgentModelSelection;
  soul: string;
  memory: string;
  memoryIds: string[];
  mcp: string;
  mcpTools: McpToolSessionSnapshot[];
  session: string;
  linkedContext: {
    repoId: string | null;
    watchId: string | null;
    taskId: string | null;
  };
  refreshBriefingContext: boolean;
  skillCatalogVersion: string;
  skills: RuntimeSkillSessionSnapshot[];
};

export function DisplayAssistant({ id }: AgentProps) {
  const delivery = useDelivery();
  const [persistedContext, setPersistedContext] =
    usePersistentState<DisplayAssistantSessionContext | null>(
      'neondeck-session-context-v2',
      null,
    );
  const refreshForBriefing =
    delivery.kind === 'signal' && delivery.type === 'neondeck.briefing.ready';
  const briefingAttributes =
    refreshForBriefing && delivery.kind === 'signal'
      ? delivery.attributes
      : undefined;
  const briefingRunId = briefingAttributes?.briefingRunId;
  const existingBriefingBinding =
    refreshForBriefing && briefingRunId
      ? readBriefingContextBindingSync(briefingRunId, id)
      : null;
  const context = existingBriefingBinding
    ? displayContextFromBriefingBinding(existingBriefingBinding)
    : !persistedContext || refreshForBriefing
      ? captureDisplayAssistantSessionContext(
          id,
          refreshForBriefing ? (briefingRunId ?? null) : null,
        )
      : persistedContext;
  const repoActions =
    delivery.kind === 'user'
      ? neondeckRepoEditActions
      : neondeckRepoReadActions;

  const writeBriefing = useDataWriter('briefing', {
    schema: briefingClientDataSchema,
  });
  useAgentStart(async ({ append }) => {
    let prepared: Awaited<
      ReturnType<typeof prepareBriefingAgentDelivery>
    > | null = null;
    let runId: string | undefined;
    if (refreshForBriefing) {
      runId = briefingRunId;
      if (!runId) throw new Error('Briefing signal is missing briefingRunId.');
      prepared = await prepareBriefingAgentDelivery({
        runId,
        sessionId: id,
        profileId: briefingAttributes?.profileId,
        snapshotVersion: briefingAttributes?.snapshotVersion,
      });
      await attachBriefingContextSnapshot({
        id: runId,
        sessionId: id,
        binding: briefingBindingFromDisplayContext(context),
      });
    }
    if (!context.pendingBriefingRunId) {
      recordDisplaySessionContextSnapshotSync({
        sessionId: id,
        snapshotId: context.snapshotId,
        memoryIds: context.memoryIds,
        refreshBriefingContext: context.refreshBriefingContext,
        linkedContext: context.linkedContext,
      });
    }
    if (!persistedContext || refreshForBriefing) setPersistedContext(context);
    if (!prepared || !runId) return;
    writeBriefing(prepared.data);
    append({
      kind: 'signal',
      type: 'neondeck.briefing.snapshot',
      tagName: 'briefing-snapshot',
      body: prepared.prompt,
      attributes: {
        briefingRunId: prepared.data.briefingRunId,
        snapshotVersion: String(prepared.data.snapshotVersion),
      },
    });
  });
  useResponseStart(() => ({
    neondeckDisplayAssistant: {
      model: context.models.displayAssistant,
      thinkingLevel: context.models.displayAssistantThinkingLevel,
    },
  }));
  useModel(context.models.displayAssistant, {
    thinkingLevel: context.models.displayAssistantThinkingLevel,
  });
  useSandbox(
    bash(
      () =>
        new Bash({
          cwd: '/workspace',
          fs: new InMemoryFs(),
        }),
    ),
    { cwd: '/workspace' },
  );

  const instructions = [
    context.soul,
    context.memory,
    context.mcp,
    context.session,
    'You are the local neondeck companion-display assistant. Keep answers brief, operational, and easy to scan on a small dashboard. When asked about work, prefer concrete next actions.',
    'Your Flue sandbox is the default virtual workspace rooted at /workspace, not the host checkout. Use Neondeck tools and app APIs for host facts, config, GitHub, watches, schedules, and runtime state.',
    'For Neondeck configuration changes, use the provided neondeck_config_* tools. Do not directly edit runtime config files in conversation.',
    'For MCP server configuration, use neondeck_mcp_server_* tools only for safe HTTP/OAuth changes. A safe HTTP server may transition from omitted/none auth to auth.kind oauth without a clientId or clientSecret; Neondeck supports OAuth dynamic client registration, so update the server and then use neondeck_mcp_login_start. Stdio servers, endpoint retargeting, header-auth servers, OAuth client-secret references, and MCP tool approval policy are user-owned and must be configured through the CLI, local API, or direct runtime config; the dashboard may surface OAuth login/logout and approval decisions. MCP config stores secret environment-variable references only; OAuth tokens are runtime state and are never readable by the agent.',
    'For display assistant, PR review, utility, self-improvement, or subagent model changes, use neondeck_config_update_agent_models. PR review is the bounded model role for fresh initial-review agents; its timeout defaults to thirty minutes and may be configured from 10,000 through 1,800,000 milliseconds. Initial and follow-up reviewers may delegate focused read-only evidence gathering to explore, but the parent reviewer owns the final review or answer. Utility is a low-cost model role for bounded helper work such as titles, labels, short summaries, notifications, and compact classification; self-improvement is the background learning/curation model role. These specialized roles are not user-facing personas. Explain that configured model strings must use already-registered providers and active sessions may need a new session or server restart.',
    'For built-in provider configuration, use neondeck_config_read_providers and neondeck_config_update_provider. Google Vertex AI has a narrower neondeck_config_update_google_vertex tool that only enables or disables registration and requires confirm=true after explicit user approval; its credentials are user-owned through neondeck init or the runtime-home .env. Provider config stores environment variable references only. Generic OpenAI-compatible endpoint definitions are user-owned configuration: explain how to use neondeck init or the local dashboard/API, but never create, change, enable, or remove one through an agent tool. Never accept raw secrets. ChatGPT subscription OAuth is user-owned CLI state managed with neondeck auth login/status/logout openai-codex. Server restart is required for provider registration or OAuth changes made by the standalone CLI.',
    'For dashboard layout changes, use neondeck_config_apply_dashboard_preset for classic or cockpit layouts, or neondeck_config_update_dashboard_layout for a complete validated custom dashboard object. Do not freestyle-edit dashboard.json.',
    'For PR watches, use the provided neondeck_watch_pr_* tools. Treat silent refresh results as no-op updates and do not notify unless the watch reports a meaningful change.',
    displayAssistantAutopilotInstructions,
    'For morning briefings, use neondeck_briefing_profile_read, neondeck_briefing_profile_update, neondeck_briefing_run_now, and neondeck_briefing_run_read for exact persisted grounding. Briefing instructions may request any configured MCP source, but do not add a briefing-specific allowlist or change MCP approval policy. For other scheduled work, use neondeck_scheduled_task_instruction_create. Scheduled instructions are admitted directly to a bounded display-assistant conversation by default; select an explicit agent session target only when the user needs continuity. Use the scheduled-task list, read, pause, resume, and delete tools to operate existing tasks.',
    'For a live diff, use neondeck_review_surfaces_lookup to resolve the intended window and neondeck_review_surface_context_lookup to page through its bounded source metadata and ephemeral findings. Use neondeck_review_surface_navigate only for one explicit surface id, keeping focus=false unless the user asked to be shown the target. Apply findings only through neondeck_review_surface_findings_apply with the exact active source and revision, stable ids, and concise bounded text; Neondeck stamps trusted provenance. Dismiss or clear findings explicitly with the exact active source and revision. Review-surface findings are process-ephemeral local context only and never create GitHub comments, submit reviews, or silently re-anchor across revisions.',
    'For PR facts, minimize tool-result context: use the narrow review-comment, requested-change, check, or branch-permission lookup when one category answers the question. Use neondeck_github_pr_event_state_get only when the task genuinely needs several event categories or a comprehensive PR/watch snapshot, and do not immediately repeat categories already present in that result. Use neondeck_pr_watch_event_state_refresh only when watch watermarks must advance, and neondeck_pr_watch_event_watermarks_list for persisted local watermarks. These GitHub fact collectors and app-state watermarks do not prepare fixes or push. Use neondeck_pr_comment only when the intended PR comment text is explicit and grounded in deterministic facts.',
    'For quick deterministic facts, prefer the neondeck_*_lookup tools. Use the relevant mutation tool when you need a durable command, mutation, scheduler tick, or persisted operation summary.',
    'For readiness, onboarding, or “why is Neon failing?” questions, use neondeck_runtime_status_lookup before answering.',
    'For safety, approval, confirmation, destructive changes, or host execution questions, use neondeck_safety_policy_lookup before answering. Destructive mutations require explicit user confirmation and tool input confirm=true.',
    'For proposed host commands, use neondeck_execution_policy_check before claiming they are allowed. A policy allow means the command is preapproved by config; ask means user approval is required before running; deny means Neon must not run it. Run approved local or exe.dev commands only through neondeck_execution_run. If a non-preapproved command needs approval first, create a request with neondeck_execution_request_approval and wait for the user or UI to resolve it.',
    'For repo-scoped exe.dev work, use neondeck_exedev_checkout_sync to create or sync the declared repo or Neondeck-managed worktree on the configured existing VM first. Then call neondeck_execution_run with repoId or worktreeId so the remote cwd and explicitly configured env forwarding apply. Env forwarding only uses enabled config sources and records source metadata in the execution audit; do not claim values were redacted by variable name.',
    'For chat sessions, use neondeck_session_list, neondeck_session_search, neondeck_session_read, neondeck_session_reference, neondeck_session_refresh_summary, neondeck_session_create, neondeck_session_switch, neondeck_session_rename, neondeck_session_pin, neondeck_session_archive, neondeck_session_restore, and neondeck_session_link_context. Flue owns actual display-assistant transcripts by session id; Neondeck owns only the metadata index, active surface selection, summaries, links, stale-context reasons, and audit rows.',
    'When the active chat session has linked repo, watch, task, PR, or summary metadata, treat that linked entity as the default subject for ambiguous follow-up questions. If the user asks "this", "that PR", "what happened", or similar without naming a target, call neondeck_session_status and use activeChatSession.summary, linked ids, and uiMetadata before answering.',
    'For active session or stale context requests, use neondeck_session_status. Create a new session with neondeck_session_create using activate=true when changed SOUL, skills, memory, or model config must enter prompt context. Switching sessions changes which Flue display-assistant session id receives future messages; it does not delete or copy history. Do not describe this as a server restart.',
    'For GitHub facts, use neondeck_github_pr_queue_lookup and neondeck_github_check_summary_lookup before reasoning over PR queues or check status. If GitHub API, check logs, PR details, or GitHub mutations require GitHub CLI, use gh through neondeck_execution_run after verifying policy.',
    'For PR assistant requests, run /review-pr, /explain-ci, /summarize-pr, /draft-pr-description, /prepare-pr, or /review-local through neondeck_command_run. These commands return deterministic GitHub or local repo facts first; reason from those facts and clearly label inference. /fix-ci starts a host-executing app operation and must use an explicit human admission surface such as the dashboard Fix CI button.',
    'For runtime skills, use neondeck_runtime_skills_lookup and neondeck_runtime_skill_load to inspect user-provided procedural guidance, and neondeck_skills_reload when a rescan is explicitly requested.',
    'For local repository status, use neondeck_repo_status_lookup when you need deterministic git facts without a persisted command summary.',
    'For interactive repository work, use neondeck_repo_file_read, neondeck_repo_file_search, neondeck_repo_file_replace, neondeck_repo_file_patch, neondeck_repo_file_write, neondeck_repo_diff, and neondeck_repo_checkout_status, then neondeck_repo_commit and neondeck_repo_push. These capabilities operate only inside declared Neondeck repo/worktree boundaries and routine edits, commits, and linked-PR-head pushes never create execution approvals. If neondeck_repo_push returns confirmPush, explain its effect and call it once more with acknowledgeExpansion=true and the returned confirmationToken only after the user confirms. Prefer replace for small edits and V4A patches for multi-file edits.',
    'For autonomous or delegated code changes, use Neondeck-managed worktrees as the isolation boundary. Create, sync, inspect, lock, release, and clean them up with neondeck_worktree_* tools. When editing inside an isolated worktree, pass worktreeId to repo-edit tools; do not mutate the user primary checkout for autonomous fix work.',
    'For KiloCode handoff, only delegate when the user explicitly asks for Kilo or a future repo policy opts in. Use neondeck_kilo_task_start for explicit handoff, then neondeck_kilo_task_status, neondeck_kilo_task_events, neondeck_kilo_task_sessions, neondeck_kilo_task_reconcile, neondeck_kilo_sessions_search, and neondeck_kilo_session_read to supervise and summarize results. Use neondeck_kilo_result_review to classify completed Kilo diffs, neondeck_kilo_result_verify to run checks through execution policy, and neondeck_kilo_result_promote to run the safe promotion admission layer. Kilo result promotion remains a separate explicitly gated path from watched-PR Autopilot; PR comments remain separate. Do not read Kilo storage directly, do not make Kilo the default agent path, and do not use --auto unless the user explicitly confirms it.',
    'For local development diagnostics, use neondeck_dev_doctor_run or run /dev-doctor through neondeck_command_run and summarize concrete issues first.',
    'For durable user preferences, local machine/tool facts, and project/repo conventions, use neondeck_memory_learn, neondeck_memory_rewrite, neondeck_memory_merge, neondeck_memory_archive, and review-mode memory candidate tools. Memory writes are limited to user, local, and project scopes. Memory rows are current guidance, not an evidence graph. Memory writes are durable immediately but active session context changes only on a new session or explicit refresh.',
    'For learning operator status, use neondeck_learning_operator_state_lookup to inspect learning reviews, candidates, memory decisions, skill patch decisions, and audit history before summarizing what Neon learned or what needs review.',
    'For procedural learning, use neondeck_learning_skill_patch_propose, neondeck_learning_skill_patch_list, neondeck_learning_skill_patch_apply, and neondeck_learning_skill_patch_reject. Skill patches are limited to the built-in neondeck skill and user skills under NEONDECK_HOME/skills, preserve frontmatter, store before/after/diff audit data, and apply only to new sessions after approval or learning policy. Applied skill patches can be restored from audit only through explicit dashboard/API/CLI user decision when the current skill file still matches the applied patch; direct model restore calls are rejected.',
    'For follow-up questions about prior conversations, search or read session metadata first and cite session ids/titles intentionally. Prefer neondeck_session_reference, stored summaries, and linked repo/watch/task metadata before requesting raw transcript pages with neondeck_session_messages. Only request raw transcript pages when the user explicitly asks for transcript detail or the active session context makes that need explicit.',
    'For follow-up questions about prior command runs, use neondeck_workflow_summaries_lookup to read legacy-named operation summaries instead of relying only on chat transcript.',
    displayAssistantDelegationInstructions,
    'When a user sends /briefing, call neondeck_briefing_run_now and pass the current display-assistant session id when it is available. The briefing must stay in the conversational briefing path, not the generic command path.',
    'When a user sends a slash command such as /repo-status, /review-queue, /review-pr, /explain-ci, /summarize-pr, /draft-pr-description, /prepare-pr, /review-local, /reasoning, /memory, /watch-pr, or /dev-doctor, call neondeck_command_run and summarize its persisted operation result. Do not run /fix-ci through neondeck_command_run.',
  ]
    .filter(Boolean)
    .join('\n\n');
  for (const skill of [
    neondeck,
    githubGh,
    ...context.skills.map(runtimeSkillFromSessionSnapshot),
  ]) {
    useSkill(skill);
  }
  for (const tool of [
    ...neondeckFactTools,
    ...mcpAgentToolsForSessionSync(context.mcpTools),
    ...neondeckBriefingActions,
    ...neondeckCommandActions,
    ...neondeckConfigActions,
    executionPolicyCheckAction,
    ...neondeckExecutionActions,
    ...neondeckMcpActions,
    ...neondeckExeDevCheckoutActions,
    ...neondeckPrEventActions,
    ...neondeckWatchActions,
    ...displayAssistantAutopilotActions,
    ...neondeckReviewSurfaceActions,
    ...neondeckScheduledTaskActions,
    ...neondeckSchedulerActions,
    ...neondeckSessionActions,
    ...neondeckRuntimeSkillActions,
    ...neondeckSkillPatchActions,
    ...neondeckLearningOperatorActions,
    ...neondeckDevDoctorActions,
    ...neondeckMemoryActions,
    ...repoActions,
    ...neondeckWorktreeActions,
    ...neondeckKiloActions,
    ...neondeckKiloResultActions,
  ]) {
    useTool(tool);
  }
  for (const subagent of neondeckSubagents(
    context.models.subagents,
    context.models.subagentThinkingLevels,
    { exploreTools: neondeckRepoReadActions },
  )) {
    useSubagent(subagent);
  }

  return instructions;
}

DisplayAssistant.agentName = 'display-assistant';

export function displayAssistantContextModelWasAdopted(
  metadata: Record<string, unknown>,
  models: Pick<
    AgentModelSelection,
    'displayAssistant' | 'displayAssistantThinkingLevel'
  >,
) {
  const value = metadata.neondeckDisplayAssistant;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const started = value as Record<string, unknown>;
  return (
    started.model === models.displayAssistant &&
    started.thinkingLevel === models.displayAssistantThinkingLevel
  );
}

function captureDisplayAssistantSessionContext(
  id: string,
  pendingBriefingRunId: string | null,
): DisplayAssistantSessionContext {
  const capturedAt = new Date().toISOString();
  const session = displaySessionContextSnapshotForAgentSync(id);
  const skills = runtimeSkillSessionSnapshotsSync();
  const snapshot = {
    version: 2 as const,
    models: readAgentModelSelectionSync(),
    soul: soulInstructions(),
    memory: session.memoryInstructions,
    memoryIds: session.memoryIds,
    mcp: mcpInstructionsSync(),
    mcpTools: mcpToolSessionSnapshotsSync(),
    session: session.instructions,
    linkedContext: session.linkedContext,
    refreshBriefingContext: session.refreshBriefingContext,
    skillCatalogVersion: createHash('sha256')
      .update(JSON.stringify(skills))
      .digest('hex'),
    skills,
  };
  return {
    ...snapshot,
    capturedAt,
    baselineSnapshotId: session.baselineSnapshotId,
    baselineLoadedAt: session.baselineLoadedAt,
    sessionContextFence: session.sessionContextFence,
    configHistoryId: session.configHistoryId,
    memoryEventSequence: session.memoryEventSequence,
    pendingBriefingRunId,
    snapshotId: createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex'),
  };
}

function briefingBindingFromDisplayContext(
  context: DisplayAssistantSessionContext,
): BriefingDisplayContextBinding {
  return {
    snapshotId: context.snapshotId,
    capturedAt: context.capturedAt,
    baselineSnapshotId: context.baselineSnapshotId,
    baselineLoadedAt: context.baselineLoadedAt,
    sessionContextFence: context.sessionContextFence,
    configHistoryId: context.configHistoryId,
    memoryEventSequence: context.memoryEventSequence,
    refreshRequired: context.refreshBriefingContext,
    model: context.models.displayAssistant,
    thinkingLevel: context.models.displayAssistantThinkingLevel,
    memoryIds: context.memoryIds,
    linkedContext: context.linkedContext,
    agentContext: JSON.parse(JSON.stringify(context)),
  };
}

function displayContextFromBriefingBinding(
  binding: BriefingDisplayContextBinding,
) {
  const context = binding.agentContext as DisplayAssistantSessionContext;
  if (context.snapshotId !== binding.snapshotId || context.version !== 2) {
    throw new Error('Briefing display-context binding is invalid.');
  }
  return context;
}
