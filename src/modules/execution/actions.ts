import { defineTool } from '@flue/runtime';
import { requestExecutionApproval } from './approvals';
import { runApprovedExecution } from './run';
import {
  executionOutputSchema,
  requestApprovalInputSchema,
  runExecutionInputSchema,
} from './schemas';

export const executionRequestApprovalAction = defineTool({
  name: 'neondeck_execution_request_approval',
  description:
    'Create a pending approval request for a non-preapproved local or exe.dev command without running it.',
  input: requestApprovalInputSchema,
  output: executionOutputSchema,
  async run({ data: input }) {
    return { output: await requestExecutionApproval(input) };
  },
});

export const executionRunAction = defineTool({
  name: 'neondeck_execution_run',
  description:
    'Run one approved local or exe.dev command through the Neondeck execution approval policy and audit log.',
  input: runExecutionInputSchema,
  output: executionOutputSchema,
  async run({ data: input }) {
    return { output: await runApprovedExecution(input) };
  },
});

export const neondeckExecutionActions = [
  executionRequestApprovalAction,
  executionRunAction,
];
