import { defineAgentProfile } from '@flue/runtime';
import type { AgentModelSelection } from './agent-config';

export function neondeckSubagents(models: AgentModelSelection['subagents']) {
  return [
    defineAgentProfile({
      name: 'repo_researcher',
      description:
        'Researches configured repositories, local status, and repo-specific context before the main assistant answers.',
      model: models.repoResearcher,
      instructions:
        'Use deterministic repo facts supplied in the delegated task. Return concise findings, risks, and concrete next steps. Do not invent repository state. Do not try to discover or run host commands.',
    }),
    defineAgentProfile({
      name: 'ci_investigator',
      description:
        'Investigates GitHub checks, CI failures, and validation status for a repo, PR, branch, or commit.',
      model: models.ciInvestigator,
      instructions:
        'Use only the check summaries, GitHub facts, logs, diffs, and command results supplied in the delegated task. Focus on check status, likely failure causes, missing data, and the next validation command. Separate observed facts from inference. If more CI data is needed, ask the main assistant to fetch it with typed GitHub tools or approved neondeck_execution_run commands such as gh pr checks or gh run view; do not try to discover gh or run raw bash yourself.',
    }),
    defineAgentProfile({
      name: 'release_reviewer',
      description:
        'Reviews release-watch, PR-watch, and scheduler state when Neon needs readiness or follow-up reasoning.',
      model: models.releaseReviewer,
      instructions:
        'Assess release readiness from provided watch, scheduler, and workflow facts. Keep the answer operational and call out blockers first.',
    }),
  ];
}
