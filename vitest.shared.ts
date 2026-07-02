export const baseExclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.astro/**',
  '**/research-repos/**',
];

export const integrationTestFiles = [
  'src/autopilot-recovery.test.ts',
  'src/autopilot-workflow-smoke.test.ts',
  'src/autopilot-workflows.test.ts',
  'src/commands.test.ts',
  'src/kilo-actions.test.ts',
  'src/kilo-results.test.ts',
  'src/kilo-workflow-smoke.test.ts',
  'src/learning-workflow-smoke.test.ts',
  'src/prepared-diffs.test.ts',
  'src/repo-edit.test.ts',
  'src/worktrees.test.ts',
];

export const sharedTestOptions = {
  testTimeout: 15_000,
  passWithNoTests: true,
};
