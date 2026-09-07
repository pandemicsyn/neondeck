/* Bounded regions intentionally support keyboard scrolling. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import { useState } from 'react';
import { getFactoryDiagnosticPreview } from '../../api/factory-diagnostics';

export function FactoryOperationsPreview({ workId }: { workId: string }) {
  return <PreviewSnapshot key={workId} workId={workId} />;
}
function PreviewSnapshot({ workId }: { workId: string }) {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function preview() {
    setBusy(true);
    setError('');
    try {
      const result = await getFactoryDiagnosticPreview(workId);
      setSnapshot(JSON.stringify(result, null, 2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preview unavailable.');
    } finally {
      setBusy(false);
    }
  }
  function download() {
    if (!snapshot) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([snapshot], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'neondeck-factory-diagnostics.json';
      anchor.click();
    } catch {
      setError('Download could not start. Retry or copy the JSON below.');
    } finally {
      if (url) {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    }
  }
  return (
    <details className="factory-operations-preview">
      <summary>Local diagnostic export</summary>
      <p>
        Preview the redacted JSON before downloading. The download contains
        exactly the snapshot shown here.
      </p>
      <div className="factory-toolbar">
        <button disabled={busy} onClick={() => void preview()}>
          {busy
            ? 'Loading preview…'
            : snapshot
              ? 'Refresh preview'
              : 'Preview diagnostics'}
        </button>
        <button disabled={busy || !snapshot} onClick={download}>
          Download shown JSON
        </button>
      </div>
      {error && (
        <p role="alert">
          {error}
          {snapshot
            ? ' The previous preview is retained.'
            : ' Retry when ready.'}
        </p>
      )}
      {snapshot && (
        <>
          <p className="factory-operations-meta">
            Fixed snapshot. Refresh preview to include later activity.
          </p>
          {/* Keyboard users can scroll the exact export without leaving the disclosure. */}
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
          <pre
            className="factory-operations-json"
            tabIndex={0}
            aria-label="Exact diagnostic JSON"
          >
            {snapshot}
          </pre>
        </>
      )}
    </details>
  );
}
