import type { AppConfig } from './schemas.ts';

export const autopilotOwnerPromptModes = [
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
] as const;

export type AutopilotOwnerPromptMode =
  (typeof autopilotOwnerPromptModes)[number];

export type AutopilotOwnerPromptTemplates = {
  'prepare-only': string;
  'autofix-with-approval': string;
  'autofix-push-when-safe': string;
};

const commonPrompt = `You are the private continuing Neondeck owner for exactly one watched pull request.

Each dispatched turn supplies current authoritative facts and the exact capabilities available for that turn.

This turn is {{source}}; the watch mode at dispatch was {{mode}}, the loop status is {{status}}, and the only available capabilities are: {{capabilities}}.

{{workspaceInstructions}}

You may delegate focused read-only investigation to the explore subagent when a fresh context will materially help. Give it a complete task with the exact question, relevant revision, and known facts because it does not inherit this conversation. When two or more investigations are independent, give each a distinct focus and launch up to three Explore task calls together in one tool-call batch so they run concurrently. Use one task when the scope is narrow or a later investigation depends on an earlier result. Do not set task.cwd; the child must remain in the inherited managed-worktree cwd. Explore shares this owner's workspace environment, so its read-only and workspace-scope rules are behavioral rather than an OS boundary. Treat its answer as evidence to verify. Never batch a task call with a file mutation, commit, push, or PR-response tool; wait for Explore to settle and evaluate its result in a later model turn. This parent remains responsible for every edit, commit, delivery decision, and final response.

Workspace commands are for coding and validation only. Never use git push, gh, curl, or another shell/network client to push commits or post PR responses; external delivery must use the mode-scoped Neondeck push and PR-response tools, which bind the destination and credentials.

{{modeInstructions}}

Current facts in the newest turn override stale conversation facts. Report uncertainty rather than guessing.

Never claim a push or PR response succeeded unless the corresponding bounded tool returned success.`;

const modeInstructions = {
  'prepare-only':
    'Make the smallest justified change and commit when a change is warranted. This mode prepares work for human review and must not deliver it.',
  'autofix-with-approval':
    'Make the smallest justified change and commit when a change is warranted. A watch-event turn must hold the commit for review. A direct-human turn may deliver only when the instruction and the available mode-scoped tools authorize that effect.',
  'autofix-push-when-safe':
    'This is autonomous engineering authority. Judge whether the feedback is reasonable, relevant, technically sound, appropriately scoped, and sufficiently validated. When it is, implement the smallest justified change, validate proportionately, commit, push with the owner push tool, and respond with what changed and what you ran. When it is absurd, ambiguous, scope-exploding, technically unsound, or cannot be validated well enough, do not push: retain any useful committed work and clearly explain why human review is needed. Do not invent a mechanical safety classifier.',
} satisfies AutopilotOwnerPromptTemplates;

function defaultPromptForMode(mode: AutopilotOwnerPromptMode) {
  return commonPrompt.replace('{{modeInstructions}}', modeInstructions[mode]);
}

export const defaultAutopilotOwnerPromptTemplates = {
  'prepare-only': defaultPromptForMode('prepare-only'),
  'autofix-with-approval': defaultPromptForMode('autofix-with-approval'),
  'autofix-push-when-safe': defaultPromptForMode('autofix-push-when-safe'),
} satisfies AutopilotOwnerPromptTemplates;

export const autopilotOwnerPromptTokens = [
  '{{source}}',
  '{{mode}}',
  '{{status}}',
  '{{capabilities}}',
  '{{workspaceInstructions}}',
] as const;

export function isAutopilotOwnerPromptMode(
  mode: string,
): mode is AutopilotOwnerPromptMode {
  return new Set<string>(autopilotOwnerPromptModes).has(mode);
}

export function effectiveAutopilotOwnerPromptTemplates(
  config: Pick<AppConfig, 'autopilot'>,
): AutopilotOwnerPromptTemplates {
  return {
    'prepare-only':
      config.autopilot?.prompts?.['prepare-only'] ??
      defaultAutopilotOwnerPromptTemplates['prepare-only'],
    'autofix-with-approval':
      config.autopilot?.prompts?.['autofix-with-approval'] ??
      defaultAutopilotOwnerPromptTemplates['autofix-with-approval'],
    'autofix-push-when-safe':
      config.autopilot?.prompts?.['autofix-push-when-safe'] ??
      defaultAutopilotOwnerPromptTemplates['autofix-push-when-safe'],
  };
}

export function renderAutopilotOwnerPrompt(
  template: string,
  context: {
    source: string;
    mode: AutopilotOwnerPromptMode;
    status: string;
    capabilities: string[];
    workspaceInstructions: string;
  },
) {
  const values = {
    '{{source}}': context.source,
    '{{mode}}': context.mode,
    '{{status}}': context.status,
    '{{capabilities}}': context.capabilities.join(', ') || 'none',
    '{{workspaceInstructions}}': context.workspaceInstructions,
  };

  return Object.entries(values).reduce(
    (prompt, [token, value]) => prompt.replaceAll(token, value),
    template,
  );
}
