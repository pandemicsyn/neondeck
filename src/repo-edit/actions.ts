import { defineAction, defineTool } from '@flue/runtime';
import {
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  searchRepoFiles,
  writeRepoFile,
} from './service';
import { patchRepoFiles } from './patch-service';
import {
  repoDiffInputSchema,
  repoEditOutputSchema,
  repoPatchInputSchema,
  repoReadInputSchema,
  repoReplaceInputSchema,
  repoSearchInputSchema,
  repoStatusInputSchema,
  repoWriteInputSchema,
} from './schemas';

export const repoFileReadAction = defineAction({
  name: 'neondeck_repo_file_read',
  description:
    'Read one text file from a configured Neondeck repo using a repo-relative path. Never prompts inside declared workspaces.',
  input: repoReadInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoFile(input);
  },
});

export const repoFileSearchAction = defineAction({
  name: 'neondeck_repo_file_search',
  description:
    'Search text files in a configured Neondeck repo using rg-style deterministic search.',
  input: repoSearchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return searchRepoFiles(input);
  },
});

export const repoFileWriteAction = defineAction({
  name: 'neondeck_repo_file_write',
  description:
    'Write a complete text file inside a configured Neondeck repo. Use for generated files or deliberate full rewrites.',
  input: repoWriteInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return writeRepoFile(input);
  },
});

export const repoFileReplaceAction = defineAction({
  name: 'neondeck_repo_file_replace',
  description:
    'Replace an exact or safe fuzzy old string with a new string inside one configured repo file.',
  input: repoReplaceInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return replaceRepoFile(input);
  },
});

export const repoFilePatchAction = defineAction({
  name: 'neondeck_repo_file_patch',
  description:
    'Apply a V4A/Codex-style multi-file patch inside a configured Neondeck repo. Validates all files before mutating.',
  input: repoPatchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return patchRepoFiles(input);
  },
});

export const repoDiffAction = defineAction({
  name: 'neondeck_repo_diff',
  description:
    'Return git-backed diff summary and optional patch content for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusAction = defineAction({
  name: 'neondeck_repo_checkout_status',
  description:
    'Return branch, upstream, ahead/behind, and changed file status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const repoDiffTool = defineTool({
  name: 'neondeck_repo_diff_lookup',
  description: 'Read git diff summary for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusTool = defineTool({
  name: 'neondeck_repo_checkout_status_lookup',
  description: 'Read checkout status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const neondeckRepoEditActions = [
  repoFileReadAction,
  repoFileSearchAction,
  repoFileWriteAction,
  repoFileReplaceAction,
  repoFilePatchAction,
  repoDiffAction,
  repoStatusAction,
];

export const neondeckRepoEditTools = [repoDiffTool, repoStatusTool];
