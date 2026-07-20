import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { listWorkflowSummaries } from '../../modules/app-state';
import { supportedCommands } from '../../modules/commands';
import { executionPolicyLookupTool } from '../../modules/execution';
import {
  getGitHubCheckSummary,
  listGitHubIssues,
  listGitHubPrQueue,
} from '../../modules/github';
import { neondeckKiloTools } from '../../modules/kilo';
import { neondeckKiloResultTools } from '../../modules/kilo/results';
import { neondeckLearningOperatorTools } from '../../modules/learning';
import { listMemories } from '../../modules/memory';
import { neondeckMcpTools } from '../../domains/mcp';
import { neondeckPrEventTools } from '../../modules/pr-events';
import { neondeckRepoEditTools } from '../../repo-edit';
import { neondeckReviewSurfaceTools } from '../../modules/review-surfaces';
import {
  listRepoStatus,
  listRuntimeSkills,
  loadRuntimeSkill,
  readRuntimeStatus,
  runtimeStatusSchema,
} from '../../modules/runtime';
import { safetyPolicyLookupTool } from '../../modules/safety';
import { listTaskRecords } from '../../modules/scheduled-tasks';
import {
  listChatSessions,
  readChatSession,
  readChatSessionMessages,
  readNeonSessionState,
  searchChatSessions,
} from '../../modules/sessions';
import { listPrWatches, listRefWatches } from '../../modules/watches';
import { neondeckWorktreeTools } from '../../modules/worktrees';

const emptyInputSchema = v.object({});
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const checkSummaryInputSchema = v.object({
  repo: nonEmptyStringSchema,
  ref: v.optional(nonEmptyStringSchema),
});
const githubIssuesInputSchema = v.object({
  repo: nonEmptyStringSchema,
  since: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.number()),
});
const skillLoadInputSchema = v.object({
  id: nonEmptyStringSchema,
});
const memoryLookupInputSchema = v.object({
  scope: v.optional(v.picklist(['user', 'local', 'project'])),
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

export const githubIssuesLookupTool = defineTool({
  name: 'neondeck_github_issues_lookup',
  description:
    'Fetch open GitHub issues for a configured repository without mutating GitHub.',
  input: githubIssuesInputSchema,
  output: toolOutputSchema,
  async run({ input }) {
    return listGitHubIssues(input);
  },
});

export const scheduledTasksLookupTool = defineTool({
  name: 'neondeck_scheduled_tasks_lookup',
  description: 'List canonical scheduled tasks and their most recent run.',
  input: emptyInputSchema,
  output: toolOutputSchema,
  async run() {
    return listTaskRecords();
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
  githubIssuesLookupTool,
  scheduledTasksLookupTool,
  prWatchesLookupTool,
  refWatchesLookupTool,
  runtimeSkillsLookupTool,
  runtimeSkillLoadTool,
  memoryLookupTool,
  ...neondeckMcpTools,
  ...neondeckLearningOperatorTools,
  safetyPolicyTool,
  executionPolicyTool,
  ...neondeckPrEventTools,
  ...neondeckReviewSurfaceTools,
  ...neondeckRepoEditTools,
  ...neondeckWorktreeTools,
  ...neondeckKiloTools,
  ...neondeckKiloResultTools,
];
