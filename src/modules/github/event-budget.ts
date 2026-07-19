export type PullRequestEventFetchBudget = {
  canFetch: (category: string) => boolean;
  admit: (category: string, value: unknown, itemCount?: number) => boolean;
  exhausted: (category: string) => boolean;
  snapshot: () => {
    maxItems: number;
    maxBytes: number;
    maxElapsedMs: number;
    retainedItems: number;
    retainedBytes: number;
    elapsedMs: number;
    exhausted: boolean;
    exhaustedCategories: string[];
  };
};

export function createPullRequestEventFetchBudget(options: {
  maxItems: number;
  maxBytes: number;
  maxElapsedMs: number;
  now?: () => number;
}): PullRequestEventFetchBudget {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let retainedItems = 0;
  let retainedBytes = 0;
  const exhaustedCategories = new Set<string>();

  const timedOut = () => now() - startedAt > options.maxElapsedMs;
  const markTimedOut = (category: string) => {
    if (!timedOut()) return false;
    exhaustedCategories.add(category);
    return true;
  };

  return {
    canFetch(category) {
      if (markTimedOut(category)) return false;
      if (
        retainedItems >= options.maxItems ||
        retainedBytes >= options.maxBytes
      ) {
        exhaustedCategories.add(category);
        return false;
      }
      return true;
    },
    admit(category, value, itemCount = 1) {
      if (markTimedOut(category)) return false;
      const byteCount = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (
        retainedItems + itemCount > options.maxItems ||
        retainedBytes + byteCount > options.maxBytes
      ) {
        exhaustedCategories.add(category);
        return false;
      }
      retainedItems += itemCount;
      retainedBytes += byteCount;
      return true;
    },
    exhausted(category) {
      return exhaustedCategories.has(category);
    },
    snapshot() {
      const elapsedMs = now() - startedAt;
      return {
        maxItems: options.maxItems,
        maxBytes: options.maxBytes,
        maxElapsedMs: options.maxElapsedMs,
        retainedItems,
        retainedBytes,
        elapsedMs,
        exhausted: exhaustedCategories.size > 0 || timedOut(),
        exhaustedCategories: [...exhaustedCategories].sort(),
      };
    },
  };
}
