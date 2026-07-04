import { defineAction, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  parseAppConfig,
  readRuntimeJson,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import {
  evaluateExecutionPolicy,
  executionPolicyCheckInputSchema,
  executionPolicyFromConfig,
  executionPolicyOutputSchema,
  type ExecutionPolicy,
  type ExecutionPolicyCheck,
} from '../execution-policy';

export type {
  ExecutionContext,
  ExecutionDecision,
  ExecutionPolicy,
  ExecutionPolicyCheck,
  ExecutionRisk,
  NormalizedPreapprovedCommand,
} from '../execution-policy';
export {
  asExecutionPolicyData,
  defaultExecutionPreapprovals,
  executionPolicyFromConfig,
  executionPolicyUpdateSchema,
  hardlineDescriptions,
  hasExecutionPolicyUpdate,
  mergeExecutionConfig,
} from '../execution-policy';

export const executionPolicyLookupTool = defineTool({
  name: 'neondeck_execution_policy_lookup',
  description:
    'Read Neondeck host execution approval policy, preapproved command defaults, and supported execution backends.',
  input: v.object({}),
  output: executionPolicyOutputSchema,
  async run() {
    return readExecutionPolicy();
  },
});

export const executionPolicyCheckAction = defineAction({
  name: 'neondeck_execution_policy_check',
  description:
    'Classify a proposed local or exe.dev command against the Neondeck execution approval policy without running it.',
  input: executionPolicyCheckInputSchema,
  output: executionPolicyOutputSchema,
  async run({ input }) {
    return checkExecutionPolicy(input);
  },
});

export async function readExecutionPolicy(
  paths: RuntimePaths = runtimePaths(),
): Promise<ExecutionPolicy> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  return executionPolicyFromConfig(config);
}

export function readExecutionPolicySync(
  paths: RuntimePaths = runtimePaths(),
): ExecutionPolicy {
  ensureRuntimeHomeSync(paths);
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  return executionPolicyFromConfig(config);
}

export async function checkExecutionPolicy(
  rawInput: v.InferInput<typeof executionPolicyCheckInputSchema>,
  paths: RuntimePaths = runtimePaths(),
): Promise<ExecutionPolicyCheck> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(executionPolicyCheckInputSchema, rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      action: 'execution_policy_check',
      changed: false,
      command: '',
      backend: 'local',
      context: 'interactive',
      decision: 'deny',
      risk: 'hardline',
      reason: `Invalid execution policy check input: ${v.summarize(parsed.issues)}`,
      requires: ['command'],
    };
  }

  return evaluateExecutionPolicy(
    parsed.output,
    await readExecutionPolicy(paths),
  );
}
