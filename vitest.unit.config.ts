import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  flueMarkdownImportsForTests,
  integrationTestFiles,
  serialUnitTestFiles,
  sharedTestOptions,
} from './vitest.shared.ts';

export default defineConfig({
  plugins: [flueMarkdownImportsForTests()],
  test: {
    ...sharedTestOptions,
    exclude: [...baseExclude, ...integrationTestFiles, ...serialUnitTestFiles],
  },
});
