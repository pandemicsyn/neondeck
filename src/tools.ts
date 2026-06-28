import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { listWorkflowSummaries } from './app-state';
import { supportedCommands } from './commands';
import { listRepoStatus } from './dev-doctor';
import { getGitHubCheckSummary, listGitHubPrQueue } from './github-actions';
import { listRuntimeSkills, loadRuntimeSkill } from './runtime-skills';
import { listSchedulerJobs } from './scheduler';
import { listPrWatches } from './watch-actions';

const emptyInputSchema = v.object({});
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const checkSummaryInputSchema = v.object({
  repo: nonEmptyStringSchema,
  ref: v.optional(nonEmptyStringSchema),
});
const skillLoadInputSchema = v.object({
  id: nonEmptyStringSchema,
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

export const neondeckFactTools = [
  commandsLookupTool,
  workflowSummariesLookupTool,
  repoStatusLookupTool,
  githubPrQueueLookupTool,
  githubCheckSummaryLookupTool,
  schedulerJobsLookupTool,
  prWatchesLookupTool,
  runtimeSkillsLookupTool,
  runtimeSkillLoadTool,
];
