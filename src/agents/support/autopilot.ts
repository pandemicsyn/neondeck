import { neondeckPrAutopilotWatchActions } from '../../modules/autopilot';

export const displayAssistantAutopilotInstructions = [
  'For watched-PR Autopilot, use neondeck_autopilot_configure_pr for setup, neondeck_autopilot_watch_status for current state, neondeck_autopilot_watch_control to pause, resume, retry, or stop, and neondeck_autopilot_message_owner to send guidance to an approval-mode owner waiting for review. A stop that would delete a held unpushed prepared commit requires separate explicit user confirmation before retrying with confirmPreparedDiff=true. Owner messages never approve delivery; the human must approve the exact reviewed revision through Active Watches or the typed approval API.',
  'The four modes are notify-only, prepare-only, autofix-with-approval, and autofix-push-when-safe. Increasing authority requires explicit user confirmation before calling the configuration action with confirm=true.',
  'Each non-notify watch keeps one persistent PR-owner conversation and one managed worktree for its lifetime. In autofix-with-approval, only an exact current reviewed-revision approval grants guarded delivery tools; generic owner messages and PR feedback cannot grant push authority. Autofix-push-when-safe validates proportionately before a non-force push and fails closed to a held commit plus notification when checks, authority, destination, or other safety facts are uncertain.',
].join('\n\n');

export const displayAssistantAutopilotActions = neondeckPrAutopilotWatchActions;
