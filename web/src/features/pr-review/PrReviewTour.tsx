import type { ReactNode } from 'react';
import type {
  PrReviewTour,
  PrReviewTourStep,
} from '../../../../shared/pr-review-tour';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import { Badge } from '../../components/ui';
import { prReviewTourAnnotationId } from './review-navigation';

export type PrReviewTourMode = 'read' | 'walk';

export function prReviewTourReadingStatus(tour: PrReviewTour) {
  const fileCount = new Set(tour.steps.map((step) => step.file)).size;
  const stepCount = tour.steps.length;
  return `Tour · reading · ${stepCount} ${stepCount === 1 ? 'step' : 'steps'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
}

export function annotationsFromPrReviewTour(
  tour: PrReviewTour | null,
  closed: boolean,
) {
  const result: Record<string, DiffReviewAnnotation[]> = {};
  if (!tour || closed) return result;
  for (const step of tour.steps) {
    (result[step.file] ??= []).push({
      side: step.anchor.side,
      lineNumber: step.anchor.endLine,
      metadata: {
        id: prReviewTourAnnotationId(step.id),
        kind: 'tour',
        title: step.symbol ?? `Step ${step.ordinal}`,
        body: step.explanation,
        tour,
        tourStep: step,
      },
    });
  }
  return result;
}

export function PrReviewTourAnnotation({
  annotation,
  onActivate,
  onAsk,
  onClose,
  selected,
}: {
  annotation: DiffReviewAnnotation;
  onActivate: (step: PrReviewTourStep) => void;
  onAsk: (step: PrReviewTourStep) => void;
  onClose: () => void;
  selected: boolean;
}) {
  const step = annotation.metadata.tourStep;
  const tour = annotation.metadata.tour;
  if (!step || !tour) return null;
  if (!selected) {
    return (
      <button
        aria-label={`Open tour step ${step.ordinal}: ${step.symbol ?? step.file}`}
        className="pr-review-tour-marker"
        data-neondeck-review-annotation="tour"
        onClick={() => onActivate(step)}
        type="button"
      >
        <span className="pr-review-tour-mark" data-ghost="">
          {step.ordinal}
        </span>
        <span className="pr-review-tour-marker-location">
          {tourStepLocation(step)}
        </span>
        <span className="pr-review-tour-marker-action">
          jump to step {step.ordinal} ›
        </span>
      </button>
    );
  }
  return (
    <article
      aria-label={`Tour step ${step.ordinal} of ${tour.steps.length}`}
      className="pr-review-tour-annotation pr-review-annotation-selected"
      data-neondeck-review-annotation="tour"
      data-navigation-selected=""
    >
      <div className="pr-review-tour-annotation-heading">
        <span className="pr-review-tour-mark">{step.ordinal}</span>
        <strong>
          <span className="pr-review-tour-location">{tourStepRange(step)}</span>
          <span className="pr-review-tour-symbol">
            {' · '}
            {step.symbol ?? step.file}
          </span>
        </strong>
        <span className="pr-review-tour-annotation-progress">
          step {step.ordinal} of {tour.steps.length}
        </span>
      </div>
      <p>{step.explanation}</p>
      <div className="pr-review-inline-actions">
        <button
          className="pr-review-tour-traverse"
          disabled={step.ordinal === 1}
          onClick={() => onActivate(tour.steps[step.ordinal - 2]!)}
          type="button"
        >
          ‹ Previous
        </button>
        <button
          className="pr-review-tour-traverse"
          disabled={step.ordinal === tour.steps.length}
          onClick={() => onActivate(tour.steps[step.ordinal]!)}
          type="button"
        >
          Next ›
        </button>
        <button onClick={() => onActivate(tour.steps[0]!)} type="button">
          Start over
        </button>
        <button onClick={() => onAsk(step)} type="button">
          Ask about this step
        </button>
        <button onClick={onClose} type="button">
          Close tour
        </button>
      </div>
    </article>
  );
}

export function PrReviewTourSpine({
  activeStepId = null,
  onActivate,
  tour,
}: {
  activeStepId: string | null;
  onActivate: (step: PrReviewTourStep) => void;
  tour: PrReviewTour;
}) {
  const activeIndex = tour.steps.findIndex((step) => step.id === activeStepId);
  return (
    <ol aria-label="Guided tour steps" className="pr-review-tour-spine">
      {tour.steps.map((step, index) => {
        const state =
          index === activeIndex ? 'now' : index < activeIndex ? 'done' : 'todo';
        return (
          <li data-state={state} key={step.id}>
            <button
              aria-current={activeStepId === step.id ? 'step' : undefined}
              onClick={() => onActivate(step)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="pr-review-tour-mark"
                data-ghost={state === 'now' ? undefined : ''}
              >
                {step.ordinal}
              </span>
              <span>
                <strong>{step.symbol ?? step.file}</strong>
                <small>
                  {step.file}:{step.anchor.startLine}
                </small>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function PrReviewTourInspectorSection({
  activeStepId,
  closed,
  mode,
  onActivate,
  onAsk,
  onBackToFinding,
  onClose,
  onModeChange,
  onOpen,
  tour,
}: {
  activeStepId: string | null;
  closed: boolean;
  mode: PrReviewTourMode;
  onActivate: (step: PrReviewTourStep) => void;
  onAsk: (step: PrReviewTourStep) => void;
  onBackToFinding: (() => void) | null;
  onClose: () => void;
  onModeChange: (mode: PrReviewTourMode) => void;
  onOpen: () => void;
  tour: PrReviewTour;
}) {
  const active = tour.steps.find((step) => step.id === activeStepId) ?? null;
  return (
    <section className="pr-review-inspector-section pr-review-tour-section">
      <div className="pr-review-inspector-heading">
        <span>Guided tour</span>
        <Badge className="pr-review-tour-progress-badge">
          {closed
            ? 'closed'
            : active
              ? `step ${active.ordinal} of ${tour.steps.length}`
              : `${tour.steps.length} ${tour.steps.length === 1 ? 'step' : 'steps'}`}
        </Badge>
      </div>
      <h3>{tour.title}</h3>
      <p className="pr-review-inspector-copy">{tour.summary}</p>
      {closed ? (
        <button
          className="pr-review-tour-primary"
          onClick={onOpen}
          type="button"
        >
          Reopen
        </button>
      ) : (
        <>
          <fieldset className="pr-review-tour-mode">
            <legend className="sr-only">Tour view</legend>
            <button
              aria-pressed={mode === 'read'}
              onClick={() => onModeChange('read')}
              type="button"
            >
              Read
            </button>
            <button
              aria-pressed={mode === 'walk'}
              onClick={() => onModeChange('walk')}
              type="button"
            >
              Walk diff
            </button>
          </fieldset>
          <PrReviewTourSpine
            activeStepId={active?.id ?? null}
            onActivate={onActivate}
            tour={tour}
          />
          <div className="pr-review-tour-actions">
            {active ? (
              <>
                <button
                  className="pr-review-tour-traverse"
                  disabled={active.ordinal === 1}
                  onClick={() => onActivate(tour.steps[active.ordinal - 2]!)}
                  type="button"
                >
                  ‹ Previous
                </button>
                <button
                  className="pr-review-tour-traverse"
                  disabled={active.ordinal === tour.steps.length}
                  onClick={() => onActivate(tour.steps[active.ordinal]!)}
                  type="button"
                >
                  Next ›
                </button>
                <button
                  onClick={() => onActivate(tour.steps[0]!)}
                  type="button"
                >
                  Start over
                </button>
                <button onClick={() => onAsk(active)} type="button">
                  Ask about this step
                </button>
              </>
            ) : (
              <button onClick={onOpen} type="button">
                Start tour
              </button>
            )}
            {onBackToFinding ? (
              <button onClick={onBackToFinding} type="button">
                Back to the finding
              </button>
            ) : null}
            <button onClick={onClose} type="button">
              Close tour
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export function PrReviewTourReadingView({
  activeStepId,
  files,
  onActivate,
  onAsk = () => undefined,
  onClose = () => undefined,
  onStartOver = () => undefined,
  tour,
}: {
  activeStepId: string | null;
  files: DiffFilePatch[];
  onActivate: (step: PrReviewTourStep) => void;
  onAsk?: (step: PrReviewTourStep) => void;
  onClose?: () => void;
  onStartOver?: () => void;
  tour: PrReviewTour;
}) {
  const patches = new Map(files.map((file) => [file.path, file.patch ?? '']));
  const fileCount = new Set(tour.steps.map((step) => step.file)).size;
  const stepCount = tour.steps.length;
  return (
    <div
      className="pr-review-tour-reading"
      aria-label={`${tour.title} reading view`}
    >
      <header>
        <p className="pr-review-tour-eyebrow">Guided code tour</p>
        <h2>{tour.title}</h2>
        <p>{tour.summary}</p>
        <div className="pr-review-tour-reading-meta">
          <Badge className="pr-review-tour-progress-badge">
            {stepCount} {stepCount === 1 ? 'step' : 'steps'}
          </Badge>
          <Badge>
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </Badge>
        </div>
      </header>
      {tour.steps.map((step, index) => (
        <article
          data-active={step.id === activeStepId ? '' : undefined}
          key={step.id}
        >
          {index > 0 ? (
            <p className="pr-review-tour-jump">
              {tourJumpLabel(tour.steps[index - 1]!, step)}
            </p>
          ) : null}
          <div className="pr-review-tour-reading-heading">
            <span className="pr-review-tour-mark">{step.ordinal}</span>
            <strong>
              <span className="pr-review-tour-location">
                {step.file} {tourStepRange(step)}
              </span>
              {step.symbol ? (
                <span className="pr-review-tour-symbol">
                  {' · '}
                  {step.symbol}
                </span>
              ) : null}
            </strong>
            <span className="pr-review-tour-reading-progress">
              step {step.ordinal} of {tour.steps.length}
            </span>
          </div>
          <pre>
            <code>{tourCodeExcerpt(patches.get(step.file) ?? '', step)}</code>
          </pre>
          <p>{step.explanation}</p>
          <div className="pr-review-tour-reading-actions">
            <button
              aria-label={`Open step ${step.ordinal} in diff: ${step.symbol ?? step.file}`}
              className="pr-review-tour-primary"
              onClick={() => onActivate(step)}
              type="button"
            >
              Open in diff ›
            </button>
            <button onClick={() => onAsk(step)} type="button">
              Ask about this step
            </button>
          </div>
        </article>
      ))}
      <footer className="pr-review-tour-reading-footer">
        <span>
          {
            'Reading view · the diff is reordered into the tour’s order, not the repository’s'
          }
        </span>
        <div>
          <button disabled onClick={onStartOver} type="button">
            Start over
          </button>
          <button onClick={onClose} type="button">
            Close tour
          </button>
        </div>
      </footer>
    </div>
  );
}

export function PrReviewTourToolPart({
  activeStepId,
  activeTour,
  closed,
  onActivate = () => undefined,
  onAsk = () => undefined,
  onClose = () => undefined,
  onOpen = () => undefined,
  onBackToFinding = null,
  part,
}: {
  activeStepId?: string | null;
  activeTour: PrReviewTour | null;
  closed: boolean;
  onActivate?: (step: PrReviewTourStep) => void;
  onAsk?: (step: PrReviewTourStep) => void;
  onClose?: () => void;
  onOpen?: () => void;
  onBackToFinding?: (() => void) | null;
  part: unknown;
}): ReactNode {
  const value = objectValue(part);
  const state = stringValue(value.state);
  const input = objectValue(value.input);
  const output = objectValue(value.output);
  const title = stringValue(input.title) || 'Guided code tour';
  const summary = stringValue(input.summary);
  if (state.includes('error') || value.errorText || value.error) {
    return (
      <div
        className="pr-review-tour-tool pr-review-tour-tool-error"
        role="alert"
      >
        <strong>Tour could not be published</strong>
        <p>
          {stringValue(value.errorText) ||
            stringValue(value.error) ||
            'The reviewer tool failed. The previous tour remains available.'}
        </p>
      </div>
    );
  }
  if (state !== 'output-available') {
    return (
      <div className="pr-review-tour-tool" aria-live="polite">
        <div className="pr-review-tour-tool-head">
          <span>Guided tour</span>
          <span className="pr-review-tour-working">tracing</span>
        </div>
        <div className="pr-review-tour-tool-body">
          <strong>{title}</strong>
          {summary ? <p>{summary}</p> : null}
          <PrReviewTourSkeleton />
        </div>
      </div>
    );
  }
  if (output.ok !== true) {
    return (
      <div
        className="pr-review-tour-tool pr-review-tour-tool-error"
        role="alert"
      >
        <strong>Tour could not be published</strong>
        <p>
          {stringValue(output.message) ||
            stringValue(output.error) ||
            'The proposed tour was not valid for this PR revision. The previous tour remains available.'}
        </p>
      </div>
    );
  }
  const outputTourId = stringValue(output.tourId);
  const generation = numberValue(output.generation);
  if (!outputTourId || generation === null) {
    return (
      <div
        className="pr-review-tour-tool pr-review-tour-tool-error"
        role="alert"
      >
        <strong>Tour publication response was incomplete</strong>
        <p>Refresh the reviewer conversation before opening this tour.</p>
      </div>
    );
  }
  const current =
    activeTour?.id === outputTourId && activeTour.generation === generation;
  if (current && closed) {
    return (
      <div className="pr-review-tour-strip">
        <span>Tour closed · {activeTour.title}</span>
        <button
          className="pr-review-tour-primary"
          onClick={onOpen}
          type="button"
        >
          Reopen
        </button>
        {onBackToFinding ? (
          <button
            className="pr-review-tour-primary"
            onClick={onBackToFinding}
            type="button"
          >
            Back to the finding
          </button>
        ) : null}
      </div>
    );
  }
  if (current) {
    const active =
      activeTour.steps.find((step) => step.id === activeStepId) ?? null;
    return (
      <div className="pr-review-tour-tool">
        <div className="pr-review-tour-tool-head">
          <span>Guided tour</span>
          <span>
            {active
              ? `${active.ordinal} / ${activeTour.steps.length}`
              : 'ready'}
          </span>
        </div>
        <div className="pr-review-tour-tool-body">
          <strong>{activeTour.title}</strong>
          <p>{activeTour.summary}</p>
          <PrReviewTourSpine
            activeStepId={active?.id ?? null}
            onActivate={onActivate}
            tour={activeTour}
          />
        </div>
        <div className="pr-review-tour-tool-foot pr-review-tour-actions">
          {active ? (
            <>
              <button
                className="pr-review-tour-traverse"
                disabled={active.ordinal === 1}
                onClick={() =>
                  onActivate(activeTour.steps[active.ordinal - 2]!)
                }
                type="button"
              >
                ‹ Previous
              </button>
              <button
                className="pr-review-tour-traverse"
                disabled={active.ordinal === activeTour.steps.length}
                onClick={() => onActivate(activeTour.steps[active.ordinal]!)}
                type="button"
              >
                Next ›
              </button>
              <button
                onClick={() => onActivate(activeTour.steps[0]!)}
                type="button"
              >
                Start over
              </button>
              <button onClick={() => onAsk(active)} type="button">
                Ask about this step
              </button>
            </>
          ) : (
            <button
              onClick={() => onActivate(activeTour.steps[0]!)}
              type="button"
            >
              Start tour
            </button>
          )}
          {onBackToFinding ? (
            <button onClick={onBackToFinding} type="button">
              Back to the finding
            </button>
          ) : null}
          <button onClick={onClose} type="button">
            Close tour
          </button>
        </div>
      </div>
    );
  }
  if (!activeTour || activeTour.generation < generation) {
    return (
      <div className="pr-review-tour-tool" aria-live="polite">
        <div className="pr-review-tour-tool-head">
          <span>Guided tour</span>
          <span>syncing</span>
        </div>
        <div className="pr-review-tour-tool-body">
          <strong>{title}</strong>
          <PrReviewTourSkeleton />
        </div>
      </div>
    );
  }
  return (
    <div className="pr-review-tour-strip pr-review-tour-tool-replaced">
      <span>Replaced · {title}</span>
      <span>newer tour active</span>
    </div>
  );
}

function PrReviewTourSkeleton() {
  return (
    <div className="pr-review-tour-skeleton" aria-hidden="true">
      <span>
        <i />
        <u />
      </span>
      <span>
        <i />
        <u />
      </span>
      <span>
        <i />
        <u />
      </span>
    </div>
  );
}

function tourStepLocation(step: PrReviewTourStep) {
  const range = tourStepRange(step);
  return step.symbol ? `${range} · ${step.symbol}` : `${range} · ${step.file}`;
}

function tourStepRange(step: PrReviewTourStep) {
  return step.anchor.startLine === step.anchor.endLine
    ? `L${step.anchor.startLine}`
    : `L${step.anchor.startLine}–L${step.anchor.endLine}`;
}

function tourCodeExcerpt(patch: string, step: PrReviewTourStep) {
  const visible = visiblePatchLines(patch, step.anchor.side);
  const excerpt = visible.filter(
    (line) =>
      line.number >= step.anchor.startLine &&
      line.number <= step.anchor.endLine,
  );
  return excerpt.length > 0
    ? excerpt
        .map((line) => `${String(line.number).padStart(5)} ${line.text}`)
        .join('\n')
    : `Lines ${step.anchor.startLine}–${step.anchor.endLine} are available in the diff view.`;
}

function tourJumpLabel(previous: PrReviewTourStep, current: PrReviewTourStep) {
  if (previous.file !== current.file) {
    return `Next: ${current.file}, line ${current.anchor.startLine} (from ${previous.file}).`;
  }
  const distance = current.anchor.startLine - previous.anchor.endLine;
  if (distance === 0) return `Next: the adjacent range in ${current.file}.`;
  return `Next: ${Math.abs(distance)} line${Math.abs(distance) === 1 ? '' : 's'} ${distance > 0 ? 'below' : 'above'} the previous step in ${current.file}.`;
}

function visiblePatchLines(
  patch: string,
  side: PrReviewTourStep['anchor']['side'],
) {
  const result: Array<{ number: number; text: string }> = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+')) {
      if (side === 'additions')
        result.push({ number: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (side === 'deletions')
        result.push({ number: oldLine, text: line.slice(1) });
      oldLine += 1;
    } else {
      result.push({
        number: side === 'additions' ? newLine : oldLine,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : null;
}
