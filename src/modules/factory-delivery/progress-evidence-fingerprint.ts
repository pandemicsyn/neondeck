import { progressDigest } from './progress-evidence-contract';
/** Timing, transport identities and revision provenance remain in the packet,
 * but cannot turn the same substantive failure into a new approach. */
export function progressFailureFingerprint(value: unknown) {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .filter(
            ([key]) =>
              ![
                'id',
                'nodeId',
                'databaseId',
                'createdAt',
                'updatedAt',
                'submittedAt',
                'startedAt',
                'completedAt',
                'durationMs',
                'headSha',
                'publishedHeadSha',
                'revision',
                'fingerprint',
              ].includes(key),
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)]),
      );
    if (typeof entry === 'string') {
      try {
        const decoded: unknown = JSON.parse(entry);
        if (decoded && typeof decoded === 'object') return normalize(decoded);
      } catch {
        /* Ordinary log text. */
      }
      return entry
        .replace(
          /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g,
          '[timestamp]',
        )
        .replace(
          /\b(?:duration|elapsed)\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:ms|s)\b/gi,
          '[elapsed]',
        );
    }
    return entry;
  };
  return progressDigest(normalize(value));
}
