import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  flueMarkdownImportsForTests,
  integrationTestFiles,
  sharedTestOptions,
} from './vitest.shared.ts';

export default defineConfig({
  plugins: [flueMarkdownImportsForTests()],
  test: {
    ...sharedTestOptions,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: baseExclude,
    include: integrationTestFiles,
  },
});
