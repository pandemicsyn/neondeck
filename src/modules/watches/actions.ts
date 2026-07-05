import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import {
  addPrWatch,
  addRefWatch,
  listPrWatches,
  listRefWatches,
  refreshPrWatch,
  refreshRefWatch,
  removePrWatch,
  setPrWatchPolling,
} from './service';
import {
  watchActionOutputSchema,
  watchPrAddInputSchema,
  watchPrPollingInputSchema,
  watchPrRefreshInputSchema,
  watchPrRemoveInputSchema,
  watchRefAddInputSchema,
  watchRefRefreshInputSchema,
} from './schemas';

export const watchPrAddAction = defineAction({
  name: 'neondeck_watch_pr_add',
  description:
    'Create a persistent PR watch from a GitHub PR URL, owner/repo#number, repo#number, or #number reference.',
  input: watchPrAddInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return addPrWatch(input);
  },
});

export const watchPrListAction = defineAction({
  name: 'neondeck_watch_pr_list',
  description: 'List persistent Neondeck PR watches.',
  input: v.object({}),
  output: watchActionOutputSchema,
  async run() {
    return listPrWatches();
  },
});

export const watchPrRemoveAction = defineAction({
  name: 'neondeck_watch_pr_remove',
  description: 'Remove a persistent PR watch after explicit confirmation.',
  input: watchPrRemoveInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return removePrWatch(input);
  },
});

export const watchPrPollingAction = defineAction({
  name: 'neondeck_watch_pr_polling',
  description: 'Pause or resume scheduler polling for a persistent PR watch.',
  input: watchPrPollingInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return setPrWatchPolling(input);
  },
});

export const watchPrRefreshAction = defineAction({
  name: 'neondeck_watch_pr_refresh',
  description:
    'Refresh one persistent PR watch and return silent when no meaningful state changed.',
  input: watchPrRefreshInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return refreshPrWatch(input);
  },
});

export const watchRefAddAction = defineAction({
  name: 'neondeck_watch_ref_add',
  description:
    'Create a persistent branch or commit ref watch from repo/ref fields, owner/repo@ref, repo@ref, or a GitHub tree/commit URL.',
  input: watchRefAddInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return addRefWatch(input);
  },
});

export const watchRefListAction = defineAction({
  name: 'neondeck_watch_ref_list',
  description: 'List persistent Neondeck branch and commit ref watches.',
  input: v.object({}),
  output: watchActionOutputSchema,
  async run() {
    return listRefWatches();
  },
});

export const watchRefRefreshAction = defineAction({
  name: 'neondeck_watch_ref_refresh',
  description:
    'Refresh one persistent branch or commit ref watch and return silent when no meaningful state changed.',
  input: watchRefRefreshInputSchema,
  output: watchActionOutputSchema,
  async run({ input }) {
    return refreshRefWatch(input);
  },
});

export const neondeckWatchActions = [
  watchPrAddAction,
  watchPrRemoveAction,
  watchPrPollingAction,
  watchPrRefreshAction,
  watchRefAddAction,
  watchRefListAction,
  watchRefRefreshAction,
];
