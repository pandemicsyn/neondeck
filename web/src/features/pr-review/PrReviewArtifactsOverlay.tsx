import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type PrReviewArtifactsOverlayProps = {
  initialReportIndex?: number;
  onClose: () => void;
  open: boolean;
  reportIds: string[];
  reviewLabel: string;
  reviewUrl: string;
};

export function PrReviewArtifactsOverlay({
  initialReportIndex = 0,
  onClose,
  open,
  reportIds,
  reviewLabel,
  reviewUrl,
}: PrReviewArtifactsOverlayProps) {
  const [activeIndex, setActiveIndex] = useState(initialReportIndex);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(initialReportIndex, reportIds.length - 1));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [initialReportIndex, onClose, open, reportIds.length]);

  if (!open || reportIds.length === 0) return null;
  const reportId = reportIds[Math.max(0, activeIndex)] ?? reportIds[0];
  const reportUrl = `/reports/${encodeURIComponent(reportId)}`;

  return createPortal(
    <dialog
      aria-label={`Review artifacts for ${reviewLabel}`}
      aria-modal="true"
      className="fixed inset-0 z-[100] m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/80 p-3 sm:p-6"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      open
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
        <iframe
          className="min-h-0 flex-1 border-0 bg-canvas"
          key={reportId}
          src={reportUrl}
          title={`${reportLabel(activeIndex)} report for ${reviewLabel}`}
        />
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
