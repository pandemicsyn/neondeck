const locks = new Map<string, Promise<void>>();

export async function withPathLocks<T>(keys: string[], fn: () => Promise<T>) {
  const sorted = [...new Set(keys)].sort();
  const releases: Array<() => void> = [];

  for (const key of sorted) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    locks.set(key, chained);
    await previous;
    releases.push(() => {
      if (locks.get(key) === chained) locks.delete(key);
      release();
    });
  }

  try {
    return await fn();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
