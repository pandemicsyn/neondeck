import type { FactoryCodingRun } from '../../../../shared/factory-coding';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getFactoryCodingRuns } from '../../api/factory-coding';
import { getFactoryDeliveryState } from '../../api/factory-delivery';
import type { FactoryDetail } from '../../../../shared/factory';
import type {
  DeliveryDetail,
  DeliveryRevision,
} from '../../api/factory-delivery';

export const factoryStages = [
  'Plan',
  'Code',
  'Validate',
  'Approve PR',
  'Watch PR',
  'Done',
] as const;
export type FactoryStage = (typeof factoryStages)[number];
export interface FactoryLifecycleState {
  stage: FactoryStage | null;
  title: string;
  nextAction: string;
}

export function sameCandidate(a: DeliveryRevision, b: DeliveryRevision) {
  return (Object.keys(a) as (keyof DeliveryRevision)[]).every(
    (key) => a[key] === b[key],
  );
}

/** A review certifies only the current candidate and its latest check bundle. */
export function currentValidation(detail: DeliveryDetail) {
  const { pipeline: p } = detail;
  const checks = p.evidence
    .filter(
      (e) => e.kind === 'verification' && sameCandidate(e.revision, p.revision),
    )
    .at(-1);
  const review = p.evidence
    .filter(
      (e) =>
        e.kind === 'review' &&
        sameCandidate(e.revision, p.revision) &&
        checks &&
        e.verificationEvidenceId === checks.id &&
        e.verificationBundleDigest === checks.bundleDigest &&
        e.validationContractDigest === checks.validationContractDigest,
    )
    .at(-1);
  return {
    checks,
    review,
    passed: checks?.result === 'passed' && review?.result === 'passed',
  };
}

export function deliveryLifecycle(
  detail: DeliveryDetail,
): FactoryLifecycleState {
  const p = detail.pipeline;
  if (detail.nextAction === 'fresh-release-required')
    return {
      stage: 'Plan',
      title: 'Release this plan again to use the updated workflow',
      nextAction:
        'Withdraw the historical release, then approve the retained plan with the updated validation policy.',
    };
  if (p.outcome === 'merged' || p.outcome === 'closed')
    return {
      stage: 'Done',
      title:
        p.outcome === 'merged' ? 'Pull request merged' : 'Pull request closed',
      nextAction: 'Inspect the retained result and evidence.',
    };
  const stage = p.pr ? 'Watch PR' : 'Validate';
  if (detail.nextAction === 'human-environment')
    return {
      stage,
      title: 'Environment setup failed',
      nextAction:
        'Inspect the failed setup command and output, correct the environment, then retry the same approved workflow. Workflow changes require renewed plan approval.',
    };
  if (detail.nextAction === 'human-budget')
    return {
      stage,
      title: 'Execution budget exhausted',
      nextAction: 'Review the budget and discuss the next step with Neon.',
    };
  if (detail.nextAction === 'human-scope')
    return {
      stage,
      title: 'Your scope decision is needed',
      nextAction: 'Review the findings and continue planning with Neon.',
    };
  if (detail.nextAction === 'human-authority')
    return {
      stage,
      title: 'Authority needs attention',
      nextAction:
        'Inspect the recorded blocker and review setup or return to planning.',
    };
  if (detail.nextAction === 'reconcile')
    return {
      stage,
      title: 'The last operation needs reconciliation',
      nextAction: 'Reconcile recorded receipts before retrying an operation.',
    };
  if (p.outcome)
    return {
      stage,
      title: `Work ${p.outcome}`,
      nextAction:
        'Inspect the retained failure or cancellation and return to planning.',
    };
  if (detail.nextAction === 'awaiting-publication')
    return {
      stage: 'Approve PR',
      title: currentValidation(detail).passed
        ? 'Review result before publication'
        : 'Current validation evidence needs attention',
      nextAction:
        'Review the exact candidate, target and remaining budget before creating a draft PR.',
    };
  if (p.pr)
    return {
      stage,
      title: 'Following pull request feedback',
      nextAction: p.coordinator.watchId
        ? 'Inspect new feedback or open the pull request.'
        : 'Watch attachment is not recorded yet. Inspect the retained pull request.',
    };
  const { checks, review, passed } = currentValidation(detail);
  if (passed)
    return {
      stage,
      title: 'Checks and review passed for this candidate',
      nextAction:
        'Inspect the review evidence and recorded publication authority.',
    };
  const unresolved = p.interventions.find((item) => !item.resolution);
  if (unresolved)
    return {
      stage,
      title: 'Validation is blocked',
      nextAction: unresolved.reason,
    };
  const active = p.effects.filter((e) => e.state === 'in-flight').at(-1);
  return {
    stage,
    title:
      active?.kind === 'review'
        ? 'Independent review in progress'
        : active?.kind === 'verification'
          ? 'Checks in progress'
          : checks?.result === 'failed' || review?.result === 'failed'
            ? 'Validation found issues'
            : 'Checks and review are not complete',
    nextAction:
      'Inspect current checks, independent review and repair progress below.',
  };
}

export function FactoryLifecycle({
  state,
  onNavigate,
}: {
  state: FactoryLifecycleState;
  onNavigate?: () => void;
}) {
  return (
    <section className="factory-lifecycle" aria-label="Task lifecycle">
      <h3>{state.title}</h3>
      <p>{state.nextAction}</p>
      {onNavigate && (
        <button type="button" onClick={onNavigate}>
          {state.stage === null
            ? 'Reload task status'
            : state.stage === 'Plan'
              ? 'Open plan and conversation'
              : state.stage === 'Approve PR'
                ? 'Review publication decision'
                : state.stage === 'Code'
                  ? 'View coding activity'
                  : state.stage === 'Watch PR'
                    ? 'Review PR feedback'
                    : 'Inspect review result'}
        </button>
      )}
      <ol aria-label="Delivery stages">
        {factoryStages.map((stage) => (
          <li
            key={stage}
            aria-current={stage === state.stage ? 'step' : undefined}
          >
            <span>{stage}</span>
            {stage === state.stage && <small>Current stage</small>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Collapse presentation, never the child tree. Do not hide the focused editor. */
export function FactoryStageSection({
  title,
  current,
  children,
  reveal = 0,
}: {
  reveal?: number;
  title: string;
  current: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(current);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  useEffect(() => {
    if (current) setOpen(true);
    else if (!body.current?.contains(document.activeElement)) setOpen(false);
  }, [current]);
  return (
    <section className="factory-stage-section">
      <button
        type="button"
        className="factory-stage-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {title}
        <span>{open ? 'Hide details' : 'Show details'}</span>
      </button>
      <div id={id} ref={body} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function useFactoryLifecycle(
  detail: FactoryDetail,
): FactoryLifecycleState {
  const runs = useInfiniteQuery({
    queryKey: ['factory-coding-runs', detail.work.id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      getFactoryCodingRuns(detail.work.id, pageParam, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: detail.eligible,
  });
  const deliveries = useQuery({
    queryKey: ['factory-delivery-state'],
    queryFn: ({ signal }) => getFactoryDeliveryState({ signal }),
    enabled: detail.eligible,
  });
  if (!detail.eligible)
    return {
      stage: 'Plan',
      title:
        detail.work.lifecycle === 'paused'
          ? 'Planning is paused'
          : detail.work.lifecycle === 'closed'
            ? 'Task is closed'
            : 'Review the plan',
      nextAction: detail.blockers.length
        ? 'Resolve the release requirements and review the current brief.'
        : 'Discuss or edit the brief, then approve its exact version.',
    };
  if (runs.error || deliveries.error)
    return {
      stage: null,
      title: 'Lifecycle status could not be refreshed',
      nextAction:
        'Retained evidence may be stale. Reload coding or review evidence before acting.',
    };
  if (runs.isPending || deliveries.isPending)
    return {
      stage: null,
      title: 'Loading task lifecycle',
      nextAction: 'Waiting for recorded coding and validation status.',
    };
  const release = detail.releases
    .filter(
      (entry) =>
        entry.specVersion === detail.work.specVersion && !entry.withdrawnAt,
    )
    .at(-1);
  const run = currentFactoryRun(
    detail.work.id,
    release?.id,
    detail.work.specVersion,
    runs.data?.pages.flatMap((page) => page.items.map((item) => item.run)) ??
      [],
  );
  const delivery = deliveries.data?.deliveries.find(
    ({ pipeline }) =>
      pipeline.workItemId === detail.work.id &&
      run &&
      pipeline.initialRevision.releaseId === run.record.snapshot.releaseId,
  );
  if (delivery) return deliveryLifecycle(delivery);
  if (run?.validationAdmission)
    return {
      stage: 'Validate',
      title: 'Validation could not start',
      nextAction: run.validationAdmission.message,
    };
  if (run?.record.candidate)
    return {
      stage: detail.releases.some(
        (release) =>
          release.id === run.record.snapshot.releaseId &&
          release.validationPolicy,
      )
        ? 'Validate'
        : 'Plan',
      title: detail.releases.some(
        (release) =>
          release.id === run.record.snapshot.releaseId &&
          release.validationPolicy,
      )
        ? 'Preparing checks and independent review'
        : 'Release this plan again to use the updated workflow',
      nextAction:
        'Inspect the retained candidate and current workflow requirements below.',
    };
  return {
    stage: 'Code',
    title:
      run?.displayStatus === 'failed'
        ? 'Coding attempt failed'
        : run?.displayStatus === 'needs-reconcile'
          ? 'Coding ownership needs reconciliation'
          : run?.displayStatus === 'running'
            ? 'Coding in progress'
            : 'Plan approved; waiting for coding',
    nextAction: 'Inspect coding activity and any setup requirements below.',
  };
}

/** Inbox state alone has no release identity; use phase evidence only for a resolved current release. */
export function factoryInboxPhase(
  item: Pick<FactoryDetail['work'], 'id' | 'lifecycle' | 'specVersion'>,
  detail:
    | {
        work: Pick<FactoryDetail['work'], 'id' | 'specVersion'>;
        eligible: boolean;
        releases: Pick<
          FactoryDetail['releases'][number],
          'id' | 'specVersion' | 'withdrawnAt'
        >[];
      }
    | undefined,
  deliveries: DeliveryDetail[],
  unavailable: boolean,
) {
  if (item.lifecycle !== 'queued')
    return item.lifecycle === 'inbox' || item.lifecycle === 'shaping'
      ? 'Plan'
      : item.lifecycle;
  if (unavailable) return 'Status unavailable';
  if (
    detail?.work.id !== item.id ||
    detail.work.specVersion !== item.specVersion
  )
    return 'Plan approved';
  if (!detail.eligible) return 'Plan approval needs review';
  const release = detail.releases
    .filter(
      (entry) => entry.specVersion === item.specVersion && !entry.withdrawnAt,
    )
    .at(-1);
  const delivery = deliveries
    .filter(
      (entry) =>
        entry.pipeline.workItemId === item.id &&
        entry.pipeline.initialRevision.releaseId === release?.id,
    )
    .at(-1);
  return delivery
    ? (deliveryLifecycle(delivery).stage ?? 'Status unavailable')
    : 'Plan approved';
}

export function currentFactoryRun(
  workId: string,
  releaseId: string | undefined,
  specVersion: number,
  runs: FactoryCodingRun[],
) {
  return runs.find(
    (run) =>
      run.record.snapshot.workItemId === workId &&
      run.record.snapshot.releaseId === releaseId &&
      run.record.snapshot.specVersion === specVersion,
  );
}
