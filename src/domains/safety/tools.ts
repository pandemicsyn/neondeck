import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { readSafetyPolicy } from './service';
import { safetyPolicySchema } from './schemas';

export const safetyPolicyLookupTool = defineTool({
  name: 'neondeck_safety_policy_lookup',
  description:
    'Read Neondeck safety and approval policy for read-only, mutation, destructive, and future host-execution actions.',
  input: v.object({}),
  output: safetyPolicySchema,
  run() {
    return readSafetyPolicy();
  },
});
