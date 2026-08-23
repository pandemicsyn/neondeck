import { markdownImportPlugin } from '@flue/vite/internal';
import type { Plugin } from 'vite';

export function flueMarkdownImportsForTests(): Plugin {
  const plugin = markdownImportPlugin();
  const transform = plugin.transform;
  if (!transform || typeof transform === 'function') return plugin;

  return {
    ...plugin,
    transform: {
      ...transform,
      filter: {
        id: { include: /\.(?:ts|mts|cts)(?:\?|$)/i },
        code: { include: [/\.md/] },
      },
    },
  } as Plugin;
}

export const baseExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.astro/**',
  '**/.claude/worktrees/**',
  '**/research-repos/**',
];

export const integrationTestFiles = [
  'src/autopilot-recovery.test.ts',
  'src/autopilot-workflows.test.ts',
  'src/commands.test.ts',
  'src/kilo-actions.test.ts',
  'src/kilo-results.test.ts',
  'src/learning-agent-smoke.test.ts',
  'src/prepared-diffs.test.ts',
  'src/repo-edit.test.ts',
  'src/worktrees.test.ts',
];

export const serialUnitTestFiles = [
  'src/ci-fix-run.test.ts',
  'src/docs-drift.test.ts',
  'src/pr-local-diffs.test.ts',
  'src/pr-reviewer-flue-lifecycle.test.ts',
  'src/pr-review-performance.test.ts',
  'src/task-authority.test.ts',
];

export const sharedTestOptions = {
  testTimeout: 15_000,
  passWithNoTests: true,
  setupFiles: ['./src/test-setup.ts'],
  env: {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'tag.gpgsign',
    GIT_CONFIG_VALUE_1: 'false',
  },
};
