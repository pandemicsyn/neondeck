import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  flueMarkdownImportsForTests,
  serialUnitTestFiles,
  sharedTestOptions,
} from './vitest.shared';

export default defineConfig({
  plugins: [flueMarkdownImportsForTests()],
  test: {
    ...sharedTestOptions,
    exclude: baseExclude,
    include: serialUnitTestFiles,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
