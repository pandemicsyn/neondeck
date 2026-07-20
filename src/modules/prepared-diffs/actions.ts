import { defineAction, defineTool } from '@flue/runtime';
import {
  listPreparedDiffs,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
} from './service';
import {
  fileDiffInputSchema,
  idInputSchema,
  listInputSchema,
  outputSchema,
} from './schemas';

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

export const neondeckPreparedDiffTools = [preparedDiffsLookupTool];
