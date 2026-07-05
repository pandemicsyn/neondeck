import type {
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
} from '@pierre/diffs/react';
// eslint-disable-next-line import/default
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';

export const diffWorkerPoolOptions = {
  workerFactory: () => new DiffWorker(),
  poolSize: workerPoolSize(),
  totalASTLRUCacheSize: 24,
} satisfies WorkerPoolOptions;

export const diffHighlighterOptions = {
  langs: [
    'bash',
    'css',
    'diff',
    'html',
    'javascript',
    'json',
    'markdown',
    'shellscript',
    'sql',
    'tsx',
    'typescript',
    'yaml',
  ],
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  useTokenTransformer: true,
  tokenizeMaxLineLength: 1800,
  lineDiffType: 'word',
  maxLineDiffLength: 1000,
} satisfies WorkerInitializationRenderOptions;

function workerPoolSize() {
  if (typeof navigator === 'undefined') return 2;
  return Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
}
