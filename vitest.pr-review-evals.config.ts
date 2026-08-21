import { defineConfig } from 'vitest/config';

import {
  flueMarkdownImportsForTests,
  sharedTestOptions,
} from './vitest.shared';

// Live-model evaluations deliberately have no relationship to the normal test
// configurations. They may take minutes and spend provider tokens.
export default defineConfig({
  plugins: [flueMarkdownImportsForTests()],
  test: {
    ...sharedTestOptions,
    setupFiles: [
      ...sharedTestOptions.setupFiles,
      './src/evals/pr-review/setup.ts',
    ],
    include: ['src/evals/pr-review/**/*.eval.ts'],
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
