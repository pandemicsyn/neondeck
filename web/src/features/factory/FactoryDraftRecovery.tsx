import { useEffect, useState } from 'react';
import type { DraftRead } from './workbench-draft';
export function FactoryDraftRecovery({
  recovery,
  onRetry,
  onDiscard,
}: {
  recovery: Extract<DraftRead, { status: 'failed' }>;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [download, setDownload] = useState<{ raw: string; url: string } | null>(
    null,
  );
  const raw = recovery.raw;
  useEffect(() => {
    if (raw === null) {
      setDownload(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([raw], { type: 'text/plain;charset=utf-8' }),
    );
    setDownload({ raw, url });
    // Keep the URL usable for repeated downloads until its data is replaced or
    // recovery ends (successful retry/discard or workbench unmount).
    return () => URL.revokeObjectURL(url);
  }, [raw]);
  return (
    <section className="factory-error" role="alert">
      <h3>Saved draft needs recovery</h3>
      <p>
        We could not restore your browser draft. Its saved data has not been
        overwritten. Automatic draft saving is paused until you retry or
        explicitly discard it.
      </p>
      <details>
        <summary>Recovery details</summary>
        <p>{recovery.error}</p>
      </details>
      {recovery.raw !== null ? (
        <>
          <label>
            Saved draft data — select and copy before discarding
            <textarea
              aria-label="Saved draft data"
              readOnly
              rows={5}
              value={recovery.raw}
              style={{ width: '100%', boxSizing: 'border-box' }}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          {download?.raw === recovery.raw && (
            <a download="factory-draft-recovery.txt" href={download.url}>
              Download saved draft
            </a>
          )}
        </>
      ) : (
        <p>
          Browser storage could not be read. Retry after restoring access;
          reloading may also restore access.
        </p>
      )}
      <div className="factory-toolbar">
        <button onClick={onRetry}>Retry draft recovery</button>
        <button onClick={() => setConfirm(true)}>Discard saved draft…</button>
      </div>
      {confirm && (
        <div>
          <p>
            Discard the saved data and enable saving the current workbench?
            Download or copy any recoverable text first.
          </p>
          <button onClick={onDiscard}>Confirm discard saved draft</button>
          <button onClick={() => setConfirm(false)}>Keep saved data</button>
        </div>
      )}
    </section>
  );
}
