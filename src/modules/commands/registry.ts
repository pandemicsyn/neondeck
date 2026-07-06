import type { NeonCommandName, ParsedNeonCommand } from './schemas';

export function supportedCommands() {
  return [
    {
      name: 'repo-status',
      usage: '/repo-status [repo-id]',
      description: 'Inspect local git status for configured repositories.',
    },
    {
      name: 'review-queue',
      usage: '/review-queue',
      description: 'Fetch and summarize the configured GitHub PR queue.',
    },
    {
      name: 'review-pr',
      usage: '/review-pr <repo#number|owner/repo#number|url>',
      description:
        'Prepare local PR review reports and Neon-origin draft comments for a human reviewer.',
    },
    {
      name: 'explain-ci',
      usage: '/explain-ci [repo#number|owner/repo#number]',
      description:
        'Explain deterministic CI/check status for a PR before agent reasoning.',
    },
    {
      name: 'summarize-pr',
      usage: '/summarize-pr [repo#number|owner/repo#number]',
      description: 'Summarize PR facts from the GitHub queue.',
    },
    {
      name: 'draft-pr-description',
      usage: '/draft-pr-description [repo-id|owner/repo]',
      description:
        'Draft a PR description scaffold from local repo status and configured metadata.',
    },
    {
      name: 'prepare-pr',
      usage: '/prepare-pr [repo-id|owner/repo]',
      description:
        'Prepare a local repo for PR creation with deterministic readiness checks.',
    },
    {
      name: 'review-local',
      usage: '/review-local [repo-id|owner/repo]',
      description:
        'Review local working tree status and call out deterministic risks.',
    },
    {
      name: 'briefing',
      usage: '/briefing',
      description:
        'Summarize repos, watches, scheduled jobs, notifications, and PR queue readiness.',
    },
    {
      name: 'reasoning',
      usage: '/reasoning [off|minimal|low|medium|high|xhigh]',
      description:
        'Show or change the active Neon session reasoning level for the selected display model.',
    },
    {
      name: 'memory',
      usage:
        '/memory [scope] | /memory set <user|local|project> <key> <json-or-text> | /memory delete <scope> <key> --confirm',
      description:
        'List or mutate durable structured memory through typed memory actions.',
    },
    {
      name: 'watch-pr',
      usage: '/watch-pr <repo#number|owner/repo#number|url>',
      description: 'Create a persistent PR watch.',
    },
    {
      name: 'dev-doctor',
      usage: '/dev-doctor',
      description:
        'Inspect local repo, package, env, port, server, and database health.',
    },
    {
      name: 'watch-release',
      usage: '/watch-release <repo-id|owner/repo>',
      description: 'Watch a configured repo until its default branch is green.',
    },
  ];
}

export function parseNeonCommand(
  input: string,
):
  | { ok: true; command: ParsedNeonCommand }
  | { ok: false; error: string; requires?: string[] } {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return {
      ok: false,
      error: 'Neon commands must start with slash.',
      requires: ['command'],
    };
  }

  const [head, ...args] = splitCommand(trimmed.slice(1));
  if (!head) {
    return {
      ok: false,
      error: 'A command name is required.',
      requires: ['command'],
    };
  }

  if (!isCommandName(head)) {
    return {
      ok: false,
      error: `Unknown Neon command "/${head}".`,
      requires: ['supportedCommand'],
    };
  }

  return {
    ok: true,
    command: {
      name: head,
      args,
      raw: trimmed,
    },
  };
}

export function splitCommand(input: string) {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) ||
    (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
}

export function isCommandName(value: string): value is NeonCommandName {
  return [
    'repo-status',
    'review-queue',
    'review-pr',
    'explain-ci',
    'summarize-pr',
    'draft-pr-description',
    'prepare-pr',
    'review-local',
    'briefing',
    'reasoning',
    'memory',
    'watch-pr',
    'dev-doctor',
    'watch-release',
  ].includes(value);
}
