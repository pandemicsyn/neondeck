import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  flueMarkdownImportsForTests,
  integrationTestFiles,
  serialUnitTestFiles,
  sharedTestOptions,
} from './vitest.shared';

export default defineConfig({
  plugins: [flueMarkdownImportsForTests()],
  test: {
    ...sharedTestOptions,
    exclude: [...baseExclude, ...integrationTestFiles, ...serialUnitTestFiles],
  },
});
