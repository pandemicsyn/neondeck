import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import {
  archiveMemory,
  listMemories,
  listMemoryEvents,
  markMemoriesUsed,
  mergeMemories,
  rewriteMemory,
  upsertMemory,
} from './service';
import {
  createMemoryCandidate,
  curateMemoryStore,
  decideMemoryCandidate,
  listMemoryCandidates,
} from './candidates';
import {
  memoryActionOutputSchema,
  memoryArchiveInputSchema,
  memoryCandidateCreateInputSchema,
  memoryCandidateDecideInputSchema,
  memoryCandidateListInputSchema,
  memoryCurateInputSchema,
  memoryEventsInputSchema,
  memoryLearnInputSchema,
  memoryListInputSchema,
  memoryMarkUsedInputSchema,
  memoryMergeInputSchema,
  memoryRewriteInputSchema,
} from './schemas';

export const memoryListAction = defineTool({
  name: 'neondeck_memory_list',
  description:
    'List durable Neondeck structured memories by optional scope, key, status, and repo id.',
  input: memoryListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    memories: v.array(v.unknown()),
  }),
  async run({ data: input }) {
    return { output: await listMemories(input) };
  },
});

export const memoryLearnAction = defineTool({
  name: 'neondeck_memory_learn',
  description:
    'Learn or update current durable guidance in user, local, or project memory with audit history.',
  input: memoryLearnInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await upsertMemory(input, runtimePaths(), { source: 'neon' }),
    };
  },
});

export const memoryRewriteAction = defineTool({
  name: 'neondeck_memory_rewrite',
  description:
    'Rewrite one active memory into clearer current guidance while preserving before/after audit history.',
  input: memoryRewriteInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await rewriteMemory(input, runtimePaths(), { source: 'neon' }),
    };
  },
});

export const memoryMergeAction = defineTool({
  name: 'neondeck_memory_merge',
  description:
    'Merge duplicate memory rows by rewriting the target and archiving source rows with audit history.',
  input: memoryMergeInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await mergeMemories(input, runtimePaths(), { source: 'neon' }),
    };
  },
});

export const memoryArchiveAction = defineTool({
  name: 'neondeck_memory_archive',
  description:
    'Archive one memory entry. Archived memories stay in audit/history but do not load into new session prompt snapshots.',
  input: memoryArchiveInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await archiveMemory(input, runtimePaths(), { source: 'neon' }),
    };
  },
});

export const memoryMarkUsedAction = defineTool({
  name: 'neondeck_memory_mark_used',
  description:
    'Increment usage counters for memories loaded into a deliberate prompt snapshot.',
  input: memoryMarkUsedInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return { output: await markMemoriesUsed(input) };
  },
});

export const memoryEventsAction = defineTool({
  name: 'neondeck_memory_events',
  description: 'List recent memory audit events.',
  input: memoryEventsInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    events: v.array(v.unknown()),
  }),
  async run({ data: input }) {
    return { output: await listMemoryEvents(input) };
  },
});

export const memoryCandidateCreateAction = defineTool({
  name: 'neondeck_memory_candidate_create',
  description:
    'Create a review-mode memory curation candidate for later approval or rejection.',
  input: memoryCandidateCreateInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await createMemoryCandidate(input, runtimePaths(), {
        source: 'neon',
      }),
    };
  },
});

export const memoryCandidateListAction = defineTool({
  name: 'neondeck_memory_candidate_list',
  description: 'List memory curation candidates awaiting review or history.',
  input: memoryCandidateListInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    candidates: v.array(v.unknown()),
  }),
  async run({ data: input }) {
    return { output: await listMemoryCandidates(input) };
  },
});

export const memoryCandidateDecideAction = defineTool({
  name: 'neondeck_memory_candidate_decide',
  description:
    'Apply, reject, or archive one memory curation candidate with audit history.',
  input: memoryCandidateDecideInputSchema,
  output: memoryActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await decideMemoryCandidate(input, runtimePaths(), {
        source: 'neon',
      }),
    };
  },
});

export const memoryCurateAction = defineTool({
  name: 'neondeck_memory_curate',
  description:
    'Run bounded memory curation. Review mode proposes candidates; auto mode applies safe archive-only overflow cleanup through typed audited actions.',
  input: memoryCurateInputSchema,
  output: v.looseObject({
    ok: v.boolean(),
    action: v.string(),
    changed: v.boolean(),
    mode: v.optional(v.string()),
    message: v.string(),
  }),
  async run({ data: input }) {
    return {
      output: await curateMemoryStore(input, runtimePaths(), {
        source: 'neon',
      }),
    };
  },
});

export const neondeckMemoryActions = [
  memoryListAction,
  memoryLearnAction,
  memoryRewriteAction,
  memoryMergeAction,
  memoryArchiveAction,
  memoryMarkUsedAction,
  memoryEventsAction,
  memoryCandidateCreateAction,
  memoryCandidateListAction,
  memoryCandidateDecideAction,
  memoryCurateAction,
];
