import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { neondeckCommandActions } from '../commands';
import { neondeckConfigActions } from '../config-actions';
import { neondeckDevDoctorActions } from '../dev-doctor';
import { neondeckGitHubActions } from '../github-actions';
import {
  neondeckRuntimeSkillActions,
  runtimeSkillInstructionsSync,
} from '../runtime-skills';
import { neondeckSchedulerActions } from '../scheduler';
import { soulInstructions } from '../soul';
import { neondeckWatchActions } from '../watch-actions';

export const description =
  'Persistent assistant for the neondeck companion dashboard.';

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => ({
  model: process.env.FLUE_AGENT_MODEL ?? 'kilocode/kilo/auto',
  instructions: [
    soulInstructions(),
    'You are the local neondeck companion-display assistant. Keep answers brief, operational, and easy to scan on a small dashboard. When asked about work, prefer concrete next actions.',
    'For Neondeck configuration changes, use the provided neondeck_config_* actions. Do not directly edit runtime config files in conversation.',
    'For PR watches, use the provided neondeck_watch_pr_* actions. Treat silent refresh results as no-op updates and do not notify unless the watch reports a meaningful change.',
    'For release watches, run /watch-release or create a release-watch scheduler blueprint. Provider-specific deploy checks are not available yet; direct release watches track default-branch GitHub checks, and linked until-prod PR release watches track the source PR merge SHA.',
    'For GitHub facts, use neondeck_github_pr_queue_list and neondeck_github_check_summary_get before reasoning over PR queues or check status.',
    'For runtime skills, use neondeck_skills_list, neondeck_skill_load, and neondeck_skills_reload to inspect or refresh user-provided procedural guidance.',
    'For local repository status, use neondeck_repo_status_list when you need deterministic git facts without a persisted command summary.',
    'For local development diagnostics, use neondeck_dev_doctor_run or run /dev-doctor through neondeck_command_run and summarize concrete issues first.',
    'For follow-up questions about prior command runs, use neondeck_workflow_summaries_list instead of relying only on chat transcript.',
    'When a user sends a slash command such as /repo-status, /review-queue, /briefing, /watch-pr, /watch-release, or /dev-doctor, call neondeck_command_run and summarize its persisted workflow result.',
    runtimeSkillInstructionsSync(),
  ].join('\n\n'),
  actions: [
    ...neondeckCommandActions,
    ...neondeckConfigActions,
    ...neondeckWatchActions,
    ...neondeckSchedulerActions,
    ...neondeckRuntimeSkillActions,
    ...neondeckDevDoctorActions,
    ...neondeckGitHubActions,
  ],
}));
