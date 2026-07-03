import { defineAction, defineTool } from '@flue/runtime';
import { abandonPreparedDiff, approvePreparedDiffPush, listPreparedDiffs, openPreparedDiffWorktree, readPreparedDiffChangedFiles, readPreparedDiffFileDiff, readPreparedDiffSummary, requestPreparedDiffRevision, runPreparedDiffVerification } from './service';
import { abandonInputSchema, approvePushInputSchema, fileDiffInputSchema, idInputSchema, listInputSchema, outputSchema, requestRevisionInputSchema, verificationInputSchema } from './schemas';

export const preparedDiffsLookupTool = defineTool({
  name: 'neondeck_prepared_diffs_lookup',
  description:
    'List prepared-diff records and pending push/revision/abandon approvals. File-level diffs remain sourced from the managed worktree.',
  input: listInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listPreparedDiffs(input);
  },
});

export const preparedDiffListAction = defineAction({
  name: 'neondeck_prepared_diff_list',
  description:
    'List prepared diffs from Neondeck app state. The source worktree is the file-level source of truth.',
  input: listInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listPreparedDiffs(input);
  },
});

export const preparedDiffSummaryAction = defineAction({
  name: 'neondeck_prepared_diff_summary',
  description:
    'Read one prepared-diff record and recompute its diff summary from the managed source worktree.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffSummary(input);
  },
});

export const preparedDiffChangedFilesAction = defineAction({
  name: 'neondeck_prepared_diff_changed_files',
  description:
    'Read changed files for one prepared diff by running backend git diff against its source worktree.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffChangedFiles(input);
  },
});

export const preparedDiffFileDiffAction = defineAction({
  name: 'neondeck_prepared_diff_file_diff',
  description:
    'Read one file patch for a prepared diff by running backend git diff against its source worktree.',
  input: fileDiffInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readPreparedDiffFileDiff(input);
  },
});

export const preparedDiffApprovePushAction = defineAction({
  name: 'neondeck_prepared_diff_approve_push',
  description:
    'Approve push-back for a prepared diff. This records approval only; the later push workflow performs the GitHub mutation.',
  input: approvePushInputSchema,
  output: outputSchema,
  async run({ input }) {
    return approvePreparedDiffPush(input);
  },
});

export const preparedDiffRequestRevisionAction = defineAction({
  name: 'neondeck_prepared_diff_request_revision',
  description:
    'Request a revision for a prepared diff and keep the source worktree available for follow-up work.',
  input: requestRevisionInputSchema,
  output: outputSchema,
  async run({ input }) {
    return requestPreparedDiffRevision(input);
  },
});

export const preparedDiffAbandonAction = defineAction({
  name: 'neondeck_prepared_diff_abandon',
  description:
    'Abandon a prepared-diff record without deleting its source worktree.',
  input: abandonInputSchema,
  output: outputSchema,
  async run({ input }) {
    return abandonPreparedDiff(input);
  },
});

export const preparedDiffOpenWorktreeAction = defineAction({
  name: 'neondeck_prepared_diff_open_worktree',
  description:
    'Return the managed source worktree path for a prepared diff so a web or TUI client can open it.',
  input: idInputSchema,
  output: outputSchema,
  async run({ input }) {
    return openPreparedDiffWorktree(input);
  },
});

export const preparedDiffRunVerificationAction = defineAction({
  name: 'neondeck_prepared_diff_run_verification',
  description:
    'Record a verification request for a prepared diff. The later verify_pr_worktree workflow owns actual command execution.',
  input: verificationInputSchema,
  output: outputSchema,
  async run({ input }) {
    return runPreparedDiffVerification(input);
  },
});

export const neondeckPreparedDiffActions = [
  preparedDiffListAction,
  preparedDiffSummaryAction,
  preparedDiffChangedFilesAction,
  preparedDiffFileDiffAction,
  preparedDiffApprovePushAction,
  preparedDiffRequestRevisionAction,
  preparedDiffAbandonAction,
  preparedDiffOpenWorktreeAction,
  preparedDiffRunVerificationAction,
];

export const neondeckPreparedDiffTools = [preparedDiffsLookupTool];
