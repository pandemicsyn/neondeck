import { defineConfig } from 'vitest/config';
import {
  baseExclude,
  integrationTestFiles,
  sharedTestOptions,
} from './vitest.shared';

export default defineConfig({
  test: {
    ...sharedTestOptions,
    exclude: baseExclude,
    include: integrationTestFiles,
  },
});
