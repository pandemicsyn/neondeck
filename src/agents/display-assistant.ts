import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../agent-config';
import { neondeckCommandActions } from '../commands';
import { neondeckConfigActions } from '../config-actions';
import { neondeckDevDoctorActions } from '../dev-doctor';
import { neondeckGitHubActions } from '../github-actions';
import {
  neondeckRuntimeSkillActions,
  runtimeSkillReferencesSync,
} from '../runtime-skills';
import { neondeckSchedulerActions } from '../scheduler';
import { soulInstructions } from '../soul';
import { neondeckSubagents } from '../subagents';
import { neondeckFactTools } from '../tools';
import { neondeckWatchActions } from '../watch-actions';
import neondeck from '../skills/neondeck/SKILL.md' with { type: 'skill' };

export const description =
  'Persistent assistant for the neondeck companion dashboard.';

export const route: AgentRouteHandler = async (_c, next) => next();

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();

  return {
    model: models.displayAssistant,
    cwd: '/workspace',
    instructions: [
      soulInstructions(),
      'You are the local neondeck companion-display assistant. Keep answers brief, operational, and easy to scan on a small dashboard. When asked about work, prefer concrete next actions.',
      'Your Flue sandbox is the default virtual workspace rooted at /workspace, not the host checkout. Use Neondeck tools and actions for host facts, config, GitHub, watches, schedules, and runtime state.',
      'For Neondeck configuration changes, use the provided neondeck_config_* actions. Do not directly edit runtime config files in conversation.',
      'For display assistant or subagent model changes, use neondeck_config_update_agent_models. Explain that configured model strings must use already-registered providers and active sessions may need a new session or server restart.',
      'For PR watches, use the provided neondeck_watch_pr_* actions. Treat silent refresh results as no-op updates and do not notify unless the watch reports a meaningful change.',
      'For release watches, run /watch-release or create a release-watch scheduler blueprint. Provider-specific deploy checks are not available yet; direct release watches track default-branch GitHub checks, and linked until-prod PR release watches track the source PR merge SHA.',
      'For quick deterministic facts, prefer the neondeck_*_lookup tools. Use actions when you need a durable command, mutation, scheduler tick, or persisted workflow summary.',
      'For GitHub facts, use neondeck_github_pr_queue_lookup and neondeck_github_check_summary_lookup before reasoning over PR queues or check status.',
      'For runtime skills, use neondeck_runtime_skills_lookup and neondeck_runtime_skill_load to inspect user-provided procedural guidance, and neondeck_skills_reload when a rescan is explicitly requested.',
      'For local repository status, use neondeck_repo_status_lookup when you need deterministic git facts without a persisted command summary.',
      'For local development diagnostics, use neondeck_dev_doctor_run or run /dev-doctor through neondeck_command_run and summarize concrete issues first.',
      'For follow-up questions about prior command runs, use neondeck_workflow_summaries_lookup instead of relying only on chat transcript.',
      'Delegate focused research to subagents when it will improve accuracy: repo_researcher for repo context, ci_investigator for checks and validation, and release_reviewer for release/watch readiness.',
      'When a user sends a slash command such as /repo-status, /review-queue, /briefing, /watch-pr, /watch-release, or /dev-doctor, call neondeck_command_run and summarize its persisted workflow result.',
    ].join('\n\n'),
    skills: [neondeck, ...runtimeSkillReferencesSync()],
    tools: neondeckFactTools,
    subagents: neondeckSubagents(models.subagents),
    actions: [
      ...neondeckCommandActions,
      ...neondeckConfigActions,
      ...neondeckWatchActions,
      ...neondeckSchedulerActions,
      ...neondeckRuntimeSkillActions,
      ...neondeckDevDoctorActions,
      ...neondeckGitHubActions,
    ],
  };
});
