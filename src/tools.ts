import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { autopilotStateLookupTool } from './autopilot';
import { neondeckAutopilotRecoveryTools } from './autopilot-recovery';
import { listWorkflowSummaries } from './app-state';
import { supportedCommands } from './commands';
import { listRepoStatus } from './dev-doctor';
import { executionPolicyLookupTool } from './execution-policy';
import { getGitHubCheckSummary, listGitHubPrQueue } from './github-actions';
import { neondeckKiloTools } from './kilo-actions';
import { neondeckKiloResultTools } from './kilo-results';
import { neondeckLearningOperatorTools } from './learning-operator';
import { listMemories } from './memory-actions';
import { neondeckPrEventTools } from './pr-event-state';
import { neondeckPreparedDiffTools } from './prepared-diffs';
import { neondeckRepoEditTools } from './repo-edit';
import { readRuntimeStatus, runtimeStatusSchema } from './runtime-status';
import { safetyPolicyLookupTool } from './safety';
import { listRuntimeSkills, loadRuntimeSkill } from './runtime-skills';
import { listSchedulerJobs } from './scheduler';
import {
  listChatSessions,
  readChatSession,
  readChatSessionMessages,
  readNeonSessionState,
  searchChatSessions,
} from './session-actions';
import { listPrWatches, listRefWatches } from './watch-actions';
import { neondeckWorktreeTools } from './worktrees';

const emptyInputSchema = v.object({});
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const checkSummaryInputSchema = v.object({
  repo: nonEmptyStringSchema,
  ref: v.optional(nonEmptyStringSchema),
});
const skillLoadInputSchema = v.object({
  id: nonEmptyStringSchema,
});
const memoryLookupInputSchema = v.object({
  scope: v.optional(
    v.picklist(['user', 'local', 'project', 'session', 'watch']),
  ),
  key: v.optional(nonEmptyStringSchema),
  status: v.optional(v.picklist(['active', 'archived'])),
  includeArchived: v.optional(v.boolean()),
});
const sessionListInputSchema = v.object({
  includeArchived: v.optional(v.boolean()),
  kind: v.optional(
    v.picklist([
      'main',
      'scratch',
      'general',
      'repo',
      'watch',
      'task',
      'briefing',
    ]),
  ),
  limit: v.optional(v.number()),
  surface: v.optional(nonEmptyStringSchema),
});
const sessionSearchInputSchema = v.object({
  query: nonEmptyStringSchema,
  includeArchived: v.optional(v.boolean()),
  limit: v.optional(v.number()),
  surface: v.optional(nonEmptyStringSchema),
});
const sessionReadInputSchema = v.object({
  id: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  surface: v.optional(nonEmptyStringSchema),
});
const sessionMessagesInputSchema = v.object({
  id: nonEmptyStringSchema,
  cursor: v.optional(v.string()),
  limit: v.optional(v.number()),
  reason: v.optional(v.string()),
  surface: v.optional(nonEmptyStringSchema),
  explicitUserRequest: v.optional(v.boolean()),
});
const toolOutputSchema = v.looseObject({
  ok: v.boolean(),
});

export const commandsLookupTool = defineTool({
  name: 'neondeck_commands_lookup',
  description:
    'List supported Neon slash commands without starting a workflow.',
  input: emptyInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    commands: v.array(v.unknown()),
  }),
  async run() {
    return { ok: true, commands: supportedCommands() };
  },
});

export const workflowSummariesLookupTool = defineTool({
  name: 'neondeck_workflow_summaries_lookup',
  description:
    'List recently persisted Neondeck workflow and command summaries for follow-up context.',
  input: emptyInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    summaries: v.array(v.unknown()),
  }),
  async run() {
    return {
      ok: true,
      summaries: await listWorkflowSummaries(),
    };
  },
});

export const runtimeStatusLookupTool = defineTool({
  name: 'neondeck_runtime_status_lookup',
  description:
    'Read whether Neon is ready, including credentials, models, repos, schedules, watches, skills, databases, and recent Flue failures.',
  input: emptyInputSchema,
  output: runtimeStatusSchema,
  async run() {
    return readRuntimeStatus();
  },
});

export const sessionStatusLookupTool = defineTool({
  name: 'neondeck_session_status_lookup',
  description:
    'Read the active Neon session id and stale context reasons without mutating session state.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return readNeonSessionState();
  },
});

export const sessionListLookupTool = defineTool({
  name: 'neondeck_session_list_lookup',
  description:
    'List Neondeck chat session metadata without reading Flue transcripts.',
  input: sessionListInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return listChatSessions(input);
  },
});

export const sessionSearchLookupTool = defineTool({
  name: 'neondeck_session_search_lookup',
  description:
    'Search chat session titles, summaries, and linked context metadata without reading raw transcripts.',
  input: sessionSearchInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return searchChatSessions(input);
  },
});

export const sessionReadLookupTool = defineTool({
  name: 'neondeck_session_read_lookup',
  description:
    'Read one chat session metadata record and audit the read without copying transcript history.',
  input: sessionReadInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return readChatSession(input);
  },
});

export const sessionMessagesLookupTool = defineTool({
  name: 'neondeck_session_messages_lookup',
  description:
    'Audit a request for Flue-owned chat session messages. Neondeck returns metadata only unless a Flue transcript reader is available.',
  input: sessionMessagesInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return readChatSessionMessages(input);
  },
});

export const repoStatusLookupTool = defineTool({
  name: 'neondeck_repo_status_lookup',
  description:
    'List deterministic local git status for configured repositories without creating a workflow summary.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listRepoStatus();
  },
});

export const githubPrQueueLookupTool = defineTool({
  name: 'neondeck_github_pr_queue_lookup',
  description:
    'Fetch the structured GitHub PR queue for configured repositories.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listGitHubPrQueue();
  },
});

export const githubCheckSummaryLookupTool = defineTool({
  name: 'neondeck_github_check_summary_lookup',
  description:
    'Fetch GitHub check-run summary for a configured repository ref or default branch.',
  input: checkSummaryInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return getGitHubCheckSummary(input);
  },
});

export const schedulerJobsLookupTool = defineTool({
  name: 'neondeck_scheduler_jobs_lookup',
  description: 'List durable Neondeck scheduler jobs and last run state.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listSchedulerJobs();
  },
});

export const prWatchesLookupTool = defineTool({
  name: 'neondeck_pr_watches_lookup',
  description: 'List persistent Neondeck PR watches.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listPrWatches();
  },
});

export const refWatchesLookupTool = defineTool({
  name: 'neondeck_ref_watches_lookup',
  description: 'List persistent Neondeck branch and commit ref watches.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listRefWatches();
  },
});

export const runtimeSkillsLookupTool = defineTool({
  name: 'neondeck_runtime_skills_lookup',
  description:
    'List discovered Neondeck runtime skills, ignored skill folders, and duplicate skill ids.',
  input: emptyInputSchema,
  output: v.looseObject({
    skills: v.array(v.unknown()),
  }),
  async run() {
    return listRuntimeSkills();
  },
});

export const runtimeSkillLoadTool = defineTool({
  name: 'neondeck_runtime_skill_load',
  description:
    'Load the full SKILL.md content for one active runtime skill by id.',
  input: skillLoadInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
  }),
  async run({ input }) {
    return loadRuntimeSkill(input);
  },
});

export const memoryLookupTool = defineTool({
  name: 'neondeck_memory_lookup',
  description:
    'List durable Neondeck structured memories by optional scope and key without changing active session context.',
  input: memoryLookupInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    memories: v.array(v.unknown()),
  }),
  async run({ input }) {
    return listMemories(input);
  },
});

export const safetyPolicyTool = safetyPolicyLookupTool;
export const executionPolicyTool = executionPolicyLookupTool;

export const neondeckFactTools = [
  commandsLookupTool,
  workflowSummariesLookupTool,
  runtimeStatusLookupTool,
  sessionStatusLookupTool,
  sessionListLookupTool,
  sessionSearchLookupTool,
  sessionReadLookupTool,
  sessionMessagesLookupTool,
  repoStatusLookupTool,
  githubPrQueueLookupTool,
  githubCheckSummaryLookupTool,
  schedulerJobsLookupTool,
  prWatchesLookupTool,
  refWatchesLookupTool,
  runtimeSkillsLookupTool,
  runtimeSkillLoadTool,
  memoryLookupTool,
  ...neondeckLearningOperatorTools,
  autopilotStateLookupTool,
  ...neondeckAutopilotRecoveryTools,
  ...neondeckPreparedDiffTools,
  safetyPolicyTool,
  executionPolicyTool,
  ...neondeckPrEventTools,
  ...neondeckRepoEditTools,
  ...neondeckWorktreeTools,
  ...neondeckKiloTools,
  ...neondeckKiloResultTools,
];
