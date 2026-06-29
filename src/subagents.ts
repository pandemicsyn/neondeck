import { defineAgentProfile } from '@flue/runtime';
import type { AgentModelSelection } from './agent-config';

export function neondeckSubagents(
  models: AgentModelSelection['subagents'],
  thinkingLevels: AgentModelSelection['subagentThinkingLevels'],
) {
  return [
    defineAgentProfile({
      name: 'repo_researcher',
      description:
        'Researches configured repositories, local status, and repo-specific context before the main assistant answers.',
      model: models.repoResearcher,
      thinkingLevel: thinkingLevels.repoResearcher,
      instructions:
        'Use deterministic repo facts supplied in the delegated task. Return concise findings, risks, and concrete next steps. Do not invent repository state.',
    }),
    defineAgentProfile({
      name: 'ci_investigator',
      description:
        'Investigates GitHub checks, CI failures, and validation status for a repo, PR, branch, or commit.',
      model: models.ciInvestigator,
      thinkingLevel: thinkingLevels.ciInvestigator,
      instructions:
        'Focus on check status, likely failure causes, missing data, and the next validation command. Separate observed facts from inference.',
    }),
    defineAgentProfile({
      name: 'release_reviewer',
      description:
        'Reviews release-watch, PR-watch, and scheduler state when Neon needs readiness or follow-up reasoning.',
      model: models.releaseReviewer,
      thinkingLevel: thinkingLevels.releaseReviewer,
      instructions:
        'Assess release readiness from provided watch, scheduler, and workflow facts. Keep the answer operational and call out blockers first.',
    }),
  ];
}
