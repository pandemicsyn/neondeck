import { neondeckPrAutopilotWatchActions } from '../../modules/autopilot';

export const displayAssistantAutopilotInstructions = [
  'For watched-PR Autopilot, use neondeck_autopilot_configure_pr for setup, neondeck_autopilot_watch_status for current state, neondeck_autopilot_watch_control to pause, resume, retry, or stop, and neondeck_autopilot_message_owner to send a direct human instruction to an approval-mode owner waiting for review.',
  'The four modes are notify-only, prepare-only, autofix-with-approval, and autofix-push-when-safe. Increasing authority requires explicit user confirmation before calling the configuration action with confirm=true.',
  'Each non-notify watch keeps one persistent PR-owner conversation and one managed worktree for its lifetime. In autofix-with-approval, approval is a direct-human turn in that same owner conversation; PR feedback cannot grant push authority. Autofix-push-when-safe runs every configured targeted check immediately before a non-force push and fails closed to a held commit plus notification when checks, authority, destination, or other safety facts are uncertain.',
].join('\n\n');

export const displayAssistantAutopilotActions = neondeckPrAutopilotWatchActions;
