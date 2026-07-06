export type FlueChatSession = {
  id: string;
  label: string;
  placeholder: string;
};

export type FlueChatCommand = {
  label: string;
  command: string;
  description?: string;
};

export type FlueChatConfig = {
  agentName: string;
  sessions: FlueChatSession[];
  quickCommands: FlueChatCommand[];
};

export const defaultCommandCatalog: FlueChatCommand[] = [
  {
    label: 'Briefing',
    command: '/briefing',
    description: 'summarize active runtime context',
  },
  {
    label: 'Reasoning',
    command: '/reasoning',
    description: 'show or change the session reasoning level',
  },
  {
    label: 'Repo',
    command: '/repo-status',
    description: 'inspect the current repo state',
  },
  {
    label: 'Queue',
    command: '/review-queue',
    description: 'list active GitHub PR work',
  },
  {
    label: 'Watch PR',
    command: '/watch-pr',
    description: 'create or inspect a PR watch',
  },
  {
    label: 'Watch release',
    command: '/watch-release',
    description: 'track release checks until green',
  },
  {
    label: 'CI',
    command: '/explain-ci',
    description: 'explain a failing check or PR ref',
  },
  {
    label: 'Fix CI',
    command: '/fix-ci',
    description: 'queue a bounded local fix for failing PR checks',
  },
  {
    label: 'PR',
    command: '/summarize-pr',
    description: 'summarize a pull request',
  },
  {
    label: 'Draft',
    command: '/draft-pr-description',
    description: 'draft a PR description from local state',
  },
  {
    label: 'Prep',
    command: '/prepare-pr',
    description: 'prepare local changes for review',
  },
  {
    label: 'Review',
    command: '/review-local',
    description: 'review local changes before pushing',
  },
  {
    label: 'Memory',
    command: '/memory',
    description: 'read or update durable memory',
  },
  {
    label: 'Doctor',
    command: '/dev-doctor',
    description: 'check local runtime readiness',
  },
];

export const flueChatDefaultConfig: FlueChatConfig = {
  agentName: 'display-assistant',
  sessions: [
    {
      id: 'neondeck-main',
      label: 'Primary',
      placeholder: 'Ask the assistant...',
    },
  ],
  quickCommands: defaultCommandCatalog,
};
