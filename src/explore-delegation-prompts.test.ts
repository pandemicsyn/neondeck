import { describe, expect, it } from 'vitest';
import { displayAssistantDelegationInstructions } from './agents/display-assistant';
import { prReviewAssistantOperationInstructions } from './agents/pr-review-assistant';
import {
  defaultAutopilotOwnerPromptTemplates,
  defaultPrReviewPromptTemplates,
} from './runtime-home';

const concurrentGuidance =
  'launch up to three Explore task calls together in one tool-call batch so they run concurrently';

describe('Explore delegation prompts', () => {
  it('teaches the display assistant to batch independent Explore tasks', () => {
    expect(displayAssistantDelegationInstructions).toContain(
      concurrentGuidance,
    );
    expect(displayAssistantDelegationInstructions).toContain(
      'Use one task when the scope is narrow',
    );
    expect(displayAssistantDelegationInstructions).toContain(
      'A concurrent delegation batch may contain only independent task calls',
    );
    expect(displayAssistantDelegationInstructions).toContain(
      'never batch a task call with a mutation or external-action tool',
    );
  });

  it('keeps concurrent Explore guidance in every Autopilot mode', () => {
    for (const prompt of Object.values(defaultAutopilotOwnerPromptTemplates)) {
      expect(prompt).toContain(concurrentGuidance);
      expect(prompt).toContain(
        'Never batch a task call with a file mutation, commit, push, or PR-response tool',
      );
    }
  });

  it('teaches initial and follow-up reviewers to batch only independent research', () => {
    expect(defaultPrReviewPromptTemplates['initial-review']).toContain(
      concurrentGuidance,
    );
    expect(defaultPrReviewPromptTemplates['follow-up-reviewer']).toContain(
      concurrentGuidance,
    );
    expect(prReviewAssistantOperationInstructions).toContain(
      concurrentGuidance,
    );
    expect(prReviewAssistantOperationInstructions).toContain(
      'Never call task and neondeck_submit_pr_review in the same tool-call batch',
    );
  });
});
