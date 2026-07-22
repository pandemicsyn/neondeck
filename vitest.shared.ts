export const baseExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.astro/**',
  '**/research-repos/**',
  'workers/github-webhook-relay/**',
];

export const integrationTestFiles = [
  'src/autopilot-recovery.test.ts',
  'src/autopilot-workflows.test.ts',
  'src/commands.test.ts',
  'src/kilo-actions.test.ts',
  'src/kilo-results.test.ts',
  'src/learning-workflow-smoke.test.ts',
  'src/prepared-diffs.test.ts',
  'src/repo-edit.test.ts',
  'src/worktrees.test.ts',
];

export const serialUnitTestFiles = [
  'src/ci-fix-run.test.ts',
  'src/docs-drift.test.ts',
  'src/pr-local-diffs.test.ts',
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
