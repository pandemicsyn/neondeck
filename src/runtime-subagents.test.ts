import { describe, expect, it } from 'vitest';
import {
  exploreSubagent,
  exploreSubagentInstructions,
  neondeckSubagents,
  resolveExploreSubagentSelection,
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

  it('requires the compact, evidence-backed Explore result contract', () => {
    expect(exploreSubagentInstructions).toContain(
      'Finish with exactly this compact result contract:',
    );
    expect(exploreSubagentInstructions).toContain(
      'Answer:\nEvidence:\n- path:line — symbol — observed fact\nUnresolved:\nInspected:\nStop reason: answered | insufficient evidence | blocked',
    );
    expect(exploreSubagentInstructions).toContain(
      'Answer the delegated question directly instead of writing a second full PR review.',
    );
  });

  it('uses current Explore defaults only when restored work has no captured selection', () => {
    const fallback = {
      model: 'openai/gpt-5.6-terra',
      thinkingLevel: 'medium' as const,
    };

    expect(resolveExploreSubagentSelection({}, fallback)).toEqual(fallback);
    expect(
      resolveExploreSubagentSelection(
        { model: 'openai/gpt-5.6-sol', thinkingLevel: 'high' },
        fallback,
      ),
    ).toEqual({ model: 'openai/gpt-5.6-sol', thinkingLevel: 'high' });
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
