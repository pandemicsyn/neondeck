import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  displayAssistantAutopilotActions,
  displayAssistantAutopilotInstructions,
} from './agents/support/autopilot';
import { neondeckFactTools } from './agents/support/tools';

const minimalActionNames = [
  'neondeck_autopilot_configure_pr',
  'neondeck_autopilot_watch_status',
  'neondeck_autopilot_watch_control',
  'neondeck_autopilot_message_owner',
];

describe('display assistant Autopilot surface', () => {
  it('advertises only the minimal watched-PR actions', () => {
    expect(displayAssistantAutopilotActions.map(({ name }) => name)).toEqual(
      minimalActionNames,
    );

    const factToolNames = neondeckFactTools.map(({ name }) => name);
    expect(factToolNames).not.toContain('neondeck_autopilot_state_lookup');
    expect(factToolNames).not.toContain(
      'neondeck_autopilot_recovery_options_lookup',
    );
    expect(
      factToolNames.filter((name) =>
        name.startsWith('neondeck_prepared_diff_'),
      ),
    ).toEqual([]);
  });

  it('describes the implemented owner loop and its authority boundaries', () => {
    for (const action of minimalActionNames) {
      expect(displayAssistantAutopilotInstructions).toContain(action);
    }
    for (const mode of [
      'notify-only',
      'prepare-only',
      'autofix-with-approval',
      'autofix-push-when-safe',
    ]) {
      expect(displayAssistantAutopilotInstructions).toContain(mode);
    }

    expect(displayAssistantAutopilotInstructions).toMatch(
      /increasing authority requires explicit user confirmation/i,
    );
    expect(displayAssistantAutopilotInstructions).toMatch(
      /one persistent PR-owner conversation and one managed worktree/i,
    );
    expect(displayAssistantAutopilotInstructions).toMatch(/direct-human turn/i);
    expect(displayAssistantAutopilotInstructions).toMatch(/non-force push/i);
    expect(displayAssistantAutopilotInstructions).toMatch(/fails closed/i);
    expect(displayAssistantAutopilotInstructions).not.toMatch(
      /being rebuilt|do not automatically dispatch|workflow-only/i,
    );
  });

  it('wires the narrow Autopilot surface into the display assistant', () => {
    const source = readFileSync(
      new URL('./agents/display-assistant.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('displayAssistantAutopilotInstructions');
    expect(source).toContain('...displayAssistantAutopilotActions');
    expect(source).not.toContain('neondeckAutopilotActions');
    expect(source).not.toContain('neondeckAutopilotRecoveryActions');
    expect(source).not.toContain('neondeckPreparedDiffActions');
  });

  it('keeps the built-in runtime skill on the same minimal surface', () => {
    const skill = readFileSync(
      new URL('./skills/neondeck/SKILL.md', import.meta.url),
      'utf8',
    );
    for (const action of minimalActionNames) {
      expect(skill).toContain(action);
    }
    expect(skill).not.toMatch(
      /neondeck_autopilot_state_lookup|neondeck_autopilot_policy_check|neondeck_prepared_diff_|neondeck_autopilot_recovery_|neondeck_autopilot_(prepare_pr_worktree|fix_pr_review_feedback|fix_pr_ci_failure|push_pr_autofix|comment_pr_autofix_result|verify_pr_worktree)/,
    );
  });
});
