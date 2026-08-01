import { defineSubagent } from '@flue/runtime';
import type { AgentModelSelection } from './agent-config';

function RepoResearcher() {
  return 'Use deterministic repo facts supplied in the delegated task. Return concise findings, risks, and concrete next steps. Do not invent repository state. Do not try to discover or run host commands.';
}

function CiInvestigator() {
  return 'Use only the check summaries, GitHub facts, logs, diffs, and command results supplied in the delegated task. Focus on check status, likely failure causes, missing data, and the next validation command. Separate observed facts from inference. If more CI data is needed, ask the main assistant to fetch it with typed GitHub tools or approved neondeck_execution_run commands such as gh pr checks or gh run view; do not try to discover gh or run raw bash yourself.';
}

function ReleaseReviewer() {
  return 'Assess release readiness from provided watch, scheduler, and workflow facts. Keep the answer operational and call out blockers first.';
}

export function neondeckSubagents(
  models: AgentModelSelection['subagents'],
  thinkingLevels: AgentModelSelection['subagentThinkingLevels'],
) {
  return [
    defineSubagent({
      name: 'repo_researcher',
      description:
        'Researches configured repositories, local status, and repo-specific context before the main assistant answers.',
      agent: RepoResearcher,
      model: models.repoResearcher,
      thinkingLevel: thinkingLevels.repoResearcher,
    }),
    defineSubagent({
      name: 'ci_investigator',
      description:
        'Investigates GitHub checks, CI failures, and validation status for a repo, PR, branch, or commit.',
      agent: CiInvestigator,
      model: models.ciInvestigator,
      thinkingLevel: thinkingLevels.ciInvestigator,
    }),
    defineSubagent({
      name: 'release_reviewer',
      description:
        'Reviews release-watch, PR-watch, and scheduler state when Neon needs readiness or follow-up reasoning.',
      agent: ReleaseReviewer,
      model: models.releaseReviewer,
      thinkingLevel: thinkingLevels.releaseReviewer,
    }),
  ];
}
