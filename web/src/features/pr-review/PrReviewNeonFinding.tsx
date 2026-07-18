import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { Badge } from '../../components/ui';
import type { NeonFindingAnchorResolution } from './review-findings';
import { findingAnchorLabel, neonFindingAnnotationId } from './review-findings';

export function PrReviewNeonFindingAnnotation({
  actionsLocked = false,
  compact,
  finding,
  isDismissing,
  isPromoting = false,
  onDismiss,
  onPromote,
  promoteLabel,
  promotionDisabledReason,
  selected,
}: {
  actionsLocked?: boolean;
  compact: boolean;
  finding: NeonReviewFinding;
  isDismissing: boolean;
  isPromoting?: boolean;
  onDismiss: (finding: NeonReviewFinding) => void;
  onPromote?: (finding: NeonReviewFinding) => void;
  promoteLabel?: string;
  promotionDisabledReason?: string | null;
  selected: boolean;
}) {
  const status = findingStatusLabel(finding);
  return (
    <article
      aria-label={`Neon ${finding.severity} finding, ${status}`}
      className={`pr-review-neon-finding${compact ? ' pr-review-neon-finding-compact' : ''}${selected ? ' pr-review-annotation-selected' : ''}`}
      data-neondeck-review-annotation="finding"
      data-navigation-selected={selected ? '' : undefined}
    >
      <div className="pr-review-neon-finding-heading">
        <span className="pr-review-neon-finding-title">{finding.title}</span>
        <span className="pr-review-neon-finding-state">
          {finding.severity} · {status}
        </span>
      </div>
      <p className="pr-review-neon-finding-copy">{finding.explanation}</p>
      {finding.suggestedAction ? (
        <p className="pr-review-neon-finding-action">
          <span>Suggested action:</span> {finding.suggestedAction}
        </p>
      ) : null}
      <FindingProvenance finding={finding} />
      <FindingPromotionHistory finding={finding} />
      {finding.lifecycle.state === 'active' ||
      finding.lifecycle.state === 'stale' ? (
        <div className="pr-review-inline-actions">
          {onPromote && promoteLabel && finding.lifecycle.state === 'active' ? (
            <button
              aria-label={`${promoteLabel}: ${finding.title}`}
              disabled={
                actionsLocked ||
                isDismissing ||
                isPromoting ||
                Boolean(promotionDisabledReason)
              }
              onClick={() => onPromote(finding)}
              title={promotionDisabledReason ?? undefined}
              type="button"
            >
              {isPromoting ? 'Promoting' : promoteLabel}
            </button>
          ) : null}
          <button
            aria-label={`Dismiss Neon finding: ${finding.title}`}
            disabled={actionsLocked || isDismissing || isPromoting}
            onClick={() => onDismiss(finding)}
            type="button"
          >
            {isDismissing ? 'Dismissing' : 'Dismiss locally'}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function PrReviewNeonFindingsPanel({
  actionsLocked = () => false,
  activePath,
  findings,
  isDismissing,
  isPromoting = () => false,
  onDismiss,
  onPromote,
  promoteLabel,
  promotionDisabledReason,
  onSelect,
  resolutionFor,
  selectedAnnotationId,
}: {
  actionsLocked?: (findingId: string) => boolean;
  activePath: string | null;
  findings: readonly NeonReviewFinding[];
  isDismissing: (findingId: string) => boolean;
  isPromoting?: (findingId: string) => boolean;
  onDismiss: (finding: NeonReviewFinding) => void;
  onPromote?: (finding: NeonReviewFinding) => void;
  promoteLabel?: string;
  promotionDisabledReason?: (finding: NeonReviewFinding) => string | null;
  onSelect: (finding: NeonReviewFinding) => void;
  resolutionFor: (finding: NeonReviewFinding) => NeonFindingAnchorResolution;
  selectedAnnotationId: string | null;
}) {
  if (findings.length === 0) return null;
  const ordered = [...findings].sort(
    (left, right) =>
      Number(right.file === activePath) - Number(left.file === activePath) ||
      left.provenance.createdAt.localeCompare(right.provenance.createdAt) ||
      left.id.localeCompare(right.id),
  );
  return (
    <section className="pr-review-inspector-section">
      <div className="pr-review-inspector-heading">
        <span>Neon findings</span>
        <Badge>{findings.length}</Badge>
      </div>
      <div className="divide-y divide-line border-t border-line">
        {ordered.map((finding) => {
          const resolution = resolutionFor(finding);
          const selected =
            selectedAnnotationId === neonFindingAnnotationId(finding.id);
          const controlContext = `${finding.title} in ${finding.file}, ${findingAnchorLabel(finding)}`;
          return (
            <article
              aria-current={selected ? 'true' : undefined}
              className="pr-review-neon-finding-summary"
              data-navigation-selected={selected ? '' : undefined}
              key={finding.id}
            >
              <div className="pr-review-neon-finding-heading">
                <span className="pr-review-neon-finding-title">
                  {finding.title}
                </span>
                <span className="pr-review-neon-finding-state">
                  {finding.severity} · {findingStatusLabel(finding)}
                </span>
              </div>
              <p className="pr-review-neon-finding-location">
                {finding.file} · {findingAnchorLabel(finding)}
              </p>
              <p className="pr-review-neon-finding-copy">
                {finding.explanation}
              </p>
              {resolution.state !== 'anchored' ? (
                <p className="pr-review-neon-finding-anchor-status">
                  {anchorStatusLabel(resolution.state)}: {resolution.reason}
                </p>
              ) : null}
              {finding.lifecycle.reason ? (
                <p className="pr-review-neon-finding-anchor-status">
                  State reason: {finding.lifecycle.reason}
                </p>
              ) : null}
              <FindingProvenance finding={finding} />
              <FindingPromotionHistory finding={finding} />
              <div className="pr-review-inline-actions">
                {finding.lifecycle.state === 'active' ? (
                  <button
                    aria-label={`${
                      resolution.state === 'anchored'
                        ? 'Show finding'
                        : 'Show file'
                    }: ${controlContext}`}
                    onClick={() => onSelect(finding)}
                    type="button"
                  >
                    {resolution.state === 'anchored'
                      ? 'Show finding'
                      : 'Show file'}
                  </button>
                ) : null}
                {finding.lifecycle.state === 'active' ||
                finding.lifecycle.state === 'stale' ? (
                  <button
                    aria-label={`Dismiss locally: ${controlContext}`}
                    disabled={
                      actionsLocked(finding.id) ||
                      isDismissing(finding.id) ||
                      isPromoting(finding.id)
                    }
                    onClick={() => onDismiss(finding)}
                    type="button"
                  >
                    {isDismissing(finding.id)
                      ? 'Dismissing'
                      : 'Dismiss locally'}
                  </button>
                ) : null}
                {finding.lifecycle.state === 'active' &&
                onPromote &&
                promoteLabel ? (
                  <button
                    aria-label={`${promoteLabel}: ${controlContext}`}
                    disabled={
                      actionsLocked(finding.id) ||
                      isDismissing(finding.id) ||
                      isPromoting(finding.id) ||
                      Boolean(promotionDisabledReason?.(finding))
                    }
                    onClick={() => onPromote(finding)}
                    title={promotionDisabledReason?.(finding) ?? undefined}
                    type="button"
                  >
                    {isPromoting(finding.id) ? 'Promoting' : promoteLabel}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function FindingPromotionHistory({ finding }: { finding: NeonReviewFinding }) {
  const promotion = finding.lifecycle.promotion;
  if (!promotion) return null;
  return (
    <p className="pr-review-neon-finding-anchor-status">
      Destination:{' '}
      {promotion.destination === 'github-review-draft'
        ? 'local GitHub review draft (submission remains separate)'
        : 'prepared-diff revision request (execution remains separate)'}
    </p>
  );
}

function FindingProvenance({ finding }: { finding: NeonReviewFinding }) {
  return (
    <p className="pr-review-neon-finding-provenance">
      Neon · role {finding.provenance.authorRole} · model{' '}
      {finding.provenance.model ?? 'unavailable'} · run{' '}
      {finding.provenance.workflowRunId ?? 'unavailable'} · created{' '}
      <time dateTime={finding.provenance.createdAt}>
        {formatFindingTime(finding.provenance.createdAt)}
      </time>
    </p>
  );
}

export function findingStatusLabel(finding: NeonReviewFinding) {
  const confidence = finding.confidence
    ? `, ${finding.confidence} confidence`
    : ', confidence unavailable';
  return `${finding.lifecycle.state}${confidence}`;
}

function anchorStatusLabel(
  state: Exclude<NeonFindingAnchorResolution['state'], 'anchored'>,
) {
  if (state === 'pending') return 'Anchor pending';
  if (state === 'stale') return 'Not attached';
  return 'Report only';
}

function formatFindingTime(value: string) {
  return value.replace('T', ' ').replace(/\.000Z$/, 'Z');
}
