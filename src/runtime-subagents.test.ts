import { describe, expect, it } from 'vitest';
import {
  exploreSubagent,
  exploreSubagentInstructions,
  neondeckSubagents,
} from './modules/runtime/subagents';

describe('runtime subagents', () => {
  it('defines Explore with its configured model and reasoning level', () => {
    const definition = exploreSubagent({
      model: 'openai/gpt-5.6-terra',
      thinkingLevel: 'medium',
    });

    expect(definition).toMatchObject({
      name: 'explore',
      model: 'openai/gpt-5.6-terra',
      thinkingLevel: 'medium',
    });
    expect(definition.agent()).toBe(exploreSubagentInstructions);
  });

  it('mounts Explore alongside the existing display specialists', () => {
    const definitions = neondeckSubagents(
      {
        explore: 'openai/gpt-5.6-terra',
        repoResearcher: 'openai/gpt-5.6-terra',
        ciInvestigator: 'openai/gpt-5.6-terra',
        releaseReviewer: 'openai/gpt-5.6-terra',
      },
      {
        explore: 'medium',
        repoResearcher: 'medium',
        ciInvestigator: 'medium',
        releaseReviewer: 'medium',
      },
    );

    expect(definitions.map(({ name }) => name)).toEqual([
      'explore',
      'repo_researcher',
      'ci_investigator',
      'release_reviewer',
    ]);
  });
});
