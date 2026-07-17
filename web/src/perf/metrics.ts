import type { ProfilerOnRenderCallback } from 'react';

export type BenchmarkCommit = {
  id: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
};

export type BenchmarkMetrics = {
  version: 1;
  scenario: string;
  fixture: Record<string, string | number | boolean>;
  startedAt: number;
  commits: BenchmarkCommit[];
  longTasks: number[];
  markdownRenders: number;
  queryRequests: number;
  queryAborts: number;
  resetInteractionMetrics: () => void;
};

declare global {
  interface Window {
    __NEONDECK_PERF__: BenchmarkMetrics;
  }
}

export function initializeBenchmarkMetrics(
  scenario: string,
  fixture: Record<string, string | number | boolean>,
) {
  const metrics: BenchmarkMetrics = {
    version: 1,
    scenario,
    fixture,
    startedAt: performance.now(),
    commits: [],
    longTasks: [],
    markdownRenders: 0,
    queryRequests: 0,
    queryAborts: 0,
    resetInteractionMetrics() {
      metrics.startedAt = performance.now();
      metrics.commits = [];
      metrics.longTasks = [];
      metrics.markdownRenders = 0;
      metrics.queryRequests = 0;
      metrics.queryAborts = 0;
    },
  };

  window.__NEONDECK_PERF__ = metrics;

  if ('PerformanceObserver' in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.push(entry.duration);
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      // Long-task observation is optional and browser-dependent.
    }
  }

  return metrics;
}

export const recordBenchmarkCommit: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  window.__NEONDECK_PERF__.commits.push({
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  });
};

export function recordMarkdownRender() {
  window.__NEONDECK_PERF__.markdownRenders += 1;
}

export function recordQueryRequest() {
  window.__NEONDECK_PERF__.queryRequests += 1;
}

export function recordQueryAbort() {
  window.__NEONDECK_PERF__.queryAborts += 1;
}
