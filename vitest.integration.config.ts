import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  integrationTestFiles,
  sharedTestOptions,
} from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: baseExclude,
    include: integrationTestFiles,
  },
});
