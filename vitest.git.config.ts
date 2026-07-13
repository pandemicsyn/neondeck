import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  serialUnitTestFiles,
  sharedTestOptions,
} from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    exclude: baseExclude,
    include: serialUnitTestFiles,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
