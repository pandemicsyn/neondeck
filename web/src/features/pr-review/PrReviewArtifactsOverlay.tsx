import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  reportDeckFromSummary,
  type ReportDeckDocument,
} from '../../../../shared/report-deck';
import { REPORT_DECK_CSS } from '../../../../shared/report-deck-styles';
import { ReportDeck } from '../../../../shared/report-deck-view';
import { reportDocumentToDeck } from '../../../../shared/report-document-to-deck';
import { reportDocumentFromSummary } from '../../../../shared/report-document';
import { getReport, getReportHtml } from '../../api/reports';
import { reportDocumentFromLegacyHtml } from './legacy-report-document';

type PrReviewArtifactsOverlayProps = {
  initialReportIndex?: number;
  onClose: () => void;
  reportIds: string[];
  reviewLabel: string;
  reviewUrl: string;
};

type ReportLoadState =
  | { key: string; status: 'loading' | 'stalled' }
  | { document: ReportDeckDocument; key: string; status: 'loaded' }
  | { key: string; message: string; status: 'error' };

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
  const [loadState, setLoadState] = useState<ReportLoadState | null>(null);
  const [focusDeckHeading, setFocusDeckHeading] = useState(false);

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
    if (!reportId || !loadKey) return;
    const controller = new AbortController();
    setLoadState({ key: loadKey, status: 'loading' });
    const timeout = window.setTimeout(() => {
      setLoadState((current) =>
        current?.key === loadKey && current.status === 'loading'
          ? { key: loadKey, status: 'stalled' }
          : current,
      );
    }, 6_000);

    void getReport(reportId, { signal: controller.signal })
      .then(async (response) => {
        let document = reportDeckFromSummary(response.item?.summary);
        if (!document) {
          const legacyDocument = reportDocumentFromSummary(
            response.item?.summary,
          );
          document = legacyDocument
            ? reportDocumentToDeck(legacyDocument)
            : null;
        }
        if (!document) {
          const html = await getReportHtml(reportId, {
            signal: controller.signal,
          });
          const legacyDocument = reportDocumentFromLegacyHtml(html);
          document = legacyDocument
            ? reportDocumentToDeck(legacyDocument)
            : null;
        }
        if (!document) {
          throw new Error('This report could not be converted for display.');
        }
        setLoadState({ document, key: loadKey, status: 'loaded' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({
          key: loadKey,
          message: error instanceof Error ? error.message : String(error),
          status: 'error',
        });
      });

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [loadKey, reportId]);

  useEffect(() => {
    if (loadState?.status !== 'loaded' || !focusDeckHeading) return;
    const timeout = window.setTimeout(() => setFocusDeckHeading(false), 0);
    return () => window.clearTimeout(timeout);
  }, [focusDeckHeading, loadState]);

  if (!reportId || !loadKey) return null;
  const reportUrl = `/reports/${encodeURIComponent(reportId)}`;
  const currentLoadState =
    loadState?.key === loadKey
      ? loadState
      : ({ key: loadKey, status: 'loading' } satisfies ReportLoadState);

  const popOut = () =>
    window.open(
      reportUrl,
      `neondeck-pr-report-${reportId}`,
      'popup,width=1180,height=860',
    );

  return createPortal(
    <>
      <style>{REPORT_DECK_CSS}</style>
      <dialog
        aria-label={`Review artifacts for ${reviewLabel}`}
        className="fixed inset-0 z-[100] m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/80 p-3 sm:p-6"
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
        ref={dialogRef}
      >
        <section className="flex h-[min(92vh,980px)] w-[min(96vw,1440px)] flex-col border border-line bg-panel">
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
                      ? 'border border-primary px-2 py-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary'
                      : 'border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary'
                  }
                  key={id}
                  onClick={() => {
                    if (index !== activeIndex) setFocusDeckHeading(true);
                    setActiveIndex(index);
                  }}
                  type="button"
                >
                  {reportLabel(index)}
                </button>
              ))}
              <button
                className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                onClick={popOut}
                type="button"
              >
                pop out
              </button>
              <a
                className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                href={reviewUrl}
                rel="noreferrer"
                target="_blank"
              >
                workbench
              </a>
              <button
                autoFocus
                className="border border-primary px-2 py-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                onClick={onClose}
                type="button"
              >
                close
              </button>
            </div>
          </header>
          <div className="relative min-h-0 flex-1 bg-canvas">
            {currentLoadState.status === 'loaded' ? (
              <ReportDeck
                className="h-full"
                deckKey={loadKey}
                document={currentLoadState.document}
                focusHeading={focusDeckHeading}
                key={loadKey}
              />
            ) : (
              <ReportLoadingState
                label={reportLabel(activeIndex)}
                message={
                  currentLoadState.status === 'error'
                    ? currentLoadState.message
                    : undefined
                }
                onPopOut={popOut}
                onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
                status={currentLoadState.status}
              />
            )}
          </div>
        </section>
      </dialog>
    </>,
    document.body,
  );
}

function ReportLoadingState({
  label,
  message,
  onPopOut,
  onRetry,
  status,
}: {
  label: string;
  message?: string;
  onPopOut: () => void;
  onRetry: () => void;
  status: 'error' | 'loading' | 'stalled';
}) {
  const needsAction = status !== 'loading';
  return (
    <output
      aria-live="polite"
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas px-4 text-center"
    >
      <div className="miami-accent h-1 w-12" />
      <p className="text-[13px] font-semibold text-ink">
        {status === 'error'
          ? `Could not load ${label}`
          : status === 'stalled'
            ? `${label} is taking longer than expected`
            : `Loading ${label}`}
      </p>
      <p className="max-w-[44ch] text-xs leading-5 text-muted">
        {status === 'error'
          ? message
          : status === 'stalled'
            ? 'The local report has not finished loading. Retry it here or open it in a separate window.'
            : 'Loading the structured local review report.'}
      </p>
      {needsAction ? (
        <div className="mt-1 flex items-center gap-2 font-mono text-[10px]">
          <button
            className="border border-primary px-2 py-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            onClick={onRetry}
            type="button"
          >
            retry
          </button>
          <button
            className="border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            onClick={onPopOut}
            type="button"
          >
            pop out
          </button>
        </div>
      ) : null}
    </output>
  );
}

function reportLabel(index: number) {
  if (index === 0) return 'overview';
  if (index === 1) return 'issues';
  return `report ${index + 1}`;
}
