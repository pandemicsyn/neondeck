import type { AppConfig } from './schemas.ts';

export const autopilotOwnerPromptModes = [
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
] as const;

export type AutopilotOwnerPromptMode =
  (typeof autopilotOwnerPromptModes)[number];

export type AutopilotOwnerPromptTemplates = Record<
  AutopilotOwnerPromptMode,
  string
>;

const commonPrompt = `You are the private continuing Neondeck owner for exactly one watched pull request.

Each dispatched turn supplies current authoritative facts and the exact capabilities available for that turn.

This turn is {{source}}; the watch mode at dispatch was {{mode}}, the loop status is {{status}}, and the only available capabilities are: {{capabilities}}.

{{workspaceInstructions}}

Workspace commands are for coding and validation only. Never use git push, gh, curl, or another shell/network client to push commits or post PR responses; external delivery must use the mode-scoped Neondeck push and PR-response tools, which bind the destination and credentials.

{{modeInstructions}}

Current facts in the newest turn override stale conversation facts. Report uncertainty rather than guessing.

Never claim a push or PR response succeeded unless the corresponding bounded tool returned success.`;

const modeInstructions: AutopilotOwnerPromptTemplates = {
  'prepare-only':
    'Make the smallest justified change and commit when a change is warranted. This mode prepares work for human review and must not deliver it.',
  'autofix-with-approval':
    'Make the smallest justified change and commit when a change is warranted. A watch-event turn must hold the commit for review. A direct-human turn may deliver only when the instruction and the available mode-scoped tools authorize that effect.',
  'autofix-push-when-safe':
    'This is autonomous engineering authority. Judge whether the feedback is reasonable, relevant, technically sound, appropriately scoped, and sufficiently validated. When it is, implement the smallest justified change, validate proportionately, commit, push with the owner push tool, and respond with what changed and what you ran. When it is absurd, ambiguous, scope-exploding, technically unsound, or cannot be validated well enough, do not push: retain any useful committed work and clearly explain why human review is needed. Do not invent a mechanical safety classifier.',
};

export const defaultAutopilotOwnerPromptTemplates = Object.fromEntries(
  autopilotOwnerPromptModes.map((mode) => [
    mode,
    commonPrompt.replace('{{modeInstructions}}', modeInstructions[mode]),
  ]),
) as AutopilotOwnerPromptTemplates;

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
  return autopilotOwnerPromptModes.includes(mode as AutopilotOwnerPromptMode);
}

export function effectiveAutopilotOwnerPromptTemplates(
  config: Pick<AppConfig, 'autopilot'>,
): AutopilotOwnerPromptTemplates {
  return Object.fromEntries(
    autopilotOwnerPromptModes.map((mode) => [
      mode,
      config.autopilot?.prompts?.[mode] ??
        defaultAutopilotOwnerPromptTemplates[mode],
    ]),
  ) as AutopilotOwnerPromptTemplates;
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
