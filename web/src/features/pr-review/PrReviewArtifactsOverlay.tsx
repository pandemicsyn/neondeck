import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type PrReviewArtifactsOverlayProps = {
  initialReportIndex?: number;
  onClose: () => void;
  reportIds: string[];
  reviewLabel: string;
  reviewUrl: string;
};

export function PrReviewArtifactsOverlay({
  initialReportIndex = 0,
  onClose,
  reportIds,
  reviewLabel,
  reviewUrl,
}: PrReviewArtifactsOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [activeIndex, setActiveIndex] = useState(initialReportIndex);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [stalledKey, setStalledKey] = useState<string | null>(null);

  useEffect(() => {
    setActiveIndex(Math.min(initialReportIndex, reportIds.length - 1));
  }, [initialReportIndex, reportIds.length]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const reportId = reportIds[Math.max(0, activeIndex)] ?? reportIds[0] ?? null;
  const loadKey = reportId ? `${reportId}:${loadAttempt}` : null;

  useEffect(() => {
    if (!loadKey) return;
    const timeout = window.setTimeout(() => setStalledKey(loadKey), 6_000);
    return () => window.clearTimeout(timeout);
  }, [loadKey]);

  if (!reportId || !loadKey) return null;
  const reportUrl = `/reports/${encodeURIComponent(reportId)}`;
  const loadState =
    loadedKey === loadKey
      ? 'loaded'
      : stalledKey === loadKey
        ? 'stalled'
        : 'loading';

  return createPortal(
    <dialog
      aria-label={`Review artifacts for ${reviewLabel}`}
      className="fixed inset-0 z-[100] m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/80 p-3 sm:p-6"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <section className="flex h-[min(92vh,980px)] w-[min(96vw,1440px)] flex-col border border-line bg-panel shadow-2xl">
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <p className="font-mono text-[10px] tracking-[0.12em] text-primary">
              PR REVIEW ARTIFACTS
            </p>
            <p className="truncate text-[11px] text-ink">{reviewLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
            {reportIds.map((id, index) => (
              <button
                aria-pressed={activeIndex === index}
                className={
                  activeIndex === index
                    ? 'border border-primary px-2 py-1 text-primary'
                    : 'border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary'
                }
                key={id}
                onClick={() => setActiveIndex(index)}
                type="button"
              >
                {reportLabel(index)}
              </button>
            ))}
            <button
              className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary"
              onClick={() =>
                window.open(
                  reportUrl,
                  `neondeck-pr-report-${reportId}`,
                  'popup,width=1180,height=860',
                )
              }
              type="button"
            >
              pop out
            </button>
            <a
              className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary"
              href={reviewUrl}
              rel="noreferrer"
              target="_blank"
            >
              workbench
            </a>
            <button
              autoFocus
              className="border border-primary px-2 py-1 text-primary"
              onClick={onClose}
              type="button"
            >
              close
            </button>
          </div>
        </header>
        <div className="relative min-h-0 flex-1 bg-canvas">
          <iframe
            className="h-full w-full border-0 bg-canvas"
            key={loadKey}
            onLoad={() => setLoadedKey(loadKey)}
            src={reportUrl}
            title={`${reportLabel(activeIndex)} report for ${reviewLabel}`}
          />
          {loadState !== 'loaded' ? (
            <output
              aria-live="polite"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-4 text-center"
            >
              <div className="miami-accent h-1 w-12" />
              <p className="text-[13px] font-semibold text-ink">
                {loadState === 'stalled'
                  ? `${reportLabel(activeIndex)} is taking longer than expected`
                  : `Loading ${reportLabel(activeIndex)}`}
              </p>
              <p className="max-w-[38ch] text-xs leading-5 text-muted">
                {loadState === 'stalled'
                  ? 'The local report has not finished opening. Retry it here or open it in a separate window.'
                  : 'Opening the local review report.'}
              </p>
              {loadState === 'stalled' ? (
                <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
                  <button
                    className="border border-primary px-2 py-1 text-primary"
                    onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                    type="button"
                  >
                    retry
                  </button>
                  <button
                    className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary"
                    onClick={() =>
                      window.open(
                        reportUrl,
                        `neondeck-pr-report-${reportId}`,
                        'popup,width=1180,height=860',
                      )
                    }
                    type="button"
                  >
                    pop out
                  </button>
                </div>
              ) : null}
            </output>
          ) : null}
        </div>
      </section>
    </dialog>,
    document.body,
  );
}

function reportLabel(index: number) {
  if (index === 0) return 'overview';
  if (index === 1) return 'issues';
  return `report ${index + 1}`;
}
