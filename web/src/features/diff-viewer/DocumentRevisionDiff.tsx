import { useMemo } from 'react';
import { FileDiff } from '@pierre/diffs/react';
import { parseDiffFromFile } from '@pierre/diffs';
import { DiffWorkerProvider, useResolvedDiffTheme } from './DiffViewer';
import { neondeckDiffOptions, neondeckDiffUnsafeCss } from './theme';

/** Retained documents, not Git revisions. This view has no PR, comment,
 * workspace or publication capabilities and does not register a PR surface. */
export type DocumentRevision = { id: string; label: string; text: string };
export function DocumentRevisionDiff({
  before,
  after,
}: {
  before: DocumentRevision;
  after: DocumentRevision;
}) {
  const theme = useResolvedDiffTheme();
  const result = useMemo(() => {
    if (before.text === after.text) return { empty: true };
    try {
      return {
        diff: parseDiffFromFile(
          {
            name: 'brief.md',
            contents: before.text + '\n',
            cacheKey: before.id,
          },
          { name: 'brief.md', contents: after.text + '\n', cacheKey: after.id },
          { context: 3 },
          true,
        ),
      };
    } catch {
      return { error: true };
    }
  }, [before, after]);
  return (
    <section aria-label="Document comparison" className="factory-document-diff">
      <p>
        {before.label} → {after.label}
      </p>
      {result.empty ? (
        <p role="status">No document changes between these versions.</p>
      ) : result.error ? (
        <div role="alert">
          <p>
            Comparison unavailable. Both retained documents are available below.
          </p>
          <details>
            <summary>{before.label}</summary>
            <pre>{before.text}</pre>
          </details>
          <details>
            <summary>{after.label}</summary>
            <pre>{after.text}</pre>
          </details>
        </div>
      ) : (
        result.diff && (
          <DiffWorkerProvider>
            <FileDiff
              fileDiff={result.diff}
              options={{
                ...neondeckDiffOptions(theme),
                unsafeCSS: neondeckDiffUnsafeCss,
              }}
            />
          </DiffWorkerProvider>
        )
      )}
    </section>
  );
}
