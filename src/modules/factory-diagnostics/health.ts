import * as v from 'valibot';
import {
  factoryHealthSchema,
  factoryTaskDiagnosisSchema,
  type FactoryTaskDiagnosis,
} from '../../../shared/factory-diagnostics';
import type { FactoryWorkerHealth } from '../../../shared/factory-observability';
import { deliveryBudget } from '../factory-delivery/store';
import type { TaskRecords } from './records';

export function diagnoseTask(
  r: TaskRecords,
  now: number,
): FactoryTaskDiagnosis {
  const deliveries = r.deliveries.filter((d) => d.outcome === null);
  const budgets = deliveries.map((d) => ({
    deliveryId: d.pipelineId,
    ...deliveryBudget(d),
  }));
  const effects: FactoryTaskDiagnosis['unresolvedEffects'] = deliveries.flatMap(
    (d) =>
      d.effects
        .filter((e) => e.state !== 'delivered')
        .map((e) => ({
          deliveryId: d.pipelineId,
          effectId: e.id,
          kind: e.kind,
          state: e.state,
        })),
  );
  const writeback = r.writeback.filter(
    (e) => !['sent', 'cancelled'].includes(e.state),
  );
  effects.push(
    ...writeback.map((e) => ({
      deliveryId: null,
      connectionId: e.connectionId,
      effectId: e.id,
      kind: `github-${e.kind}`,
      state: e.state,
    })),
  );
  const run = r.runs[0];
  const planning = r.planning.find(
    (p) => p.stage === 'triage' || p.stage === 'planner',
  );
  let status: string = r.work.lifecycle;
  let pendingSince: string | null = r.work.updatedAt;
  let nextStep =
    'Inspect the draft and resolve decisions before releasing an exact specification.';
  const nextRetry = writeback
    .filter((e) => e.retryAt > 0 && ['pending', 'failed'].includes(e.state))
    .map((e) => e.retryAt)
    .sort((a, b) => a - b)[0];
  const assessment = deliveries
    .flatMap((d) => d.progress.assessments)
    .find((a) => a.state !== 'settled');
  if (r.work.lifecycle === 'closed') {
    status = 'closed';
    pendingSince = null;
    nextStep = 'Task is closed. Inspect retained outcomes and evidence.';
  } else if (effects.some((e) => ['uncertain', 'repair'].includes(e.state))) {
    status = 'needs-reconciliation';
    pendingSince = null;
    nextStep =
      'Inspect unresolved effects and reconcile through the existing operator controls. Do not retry an ambiguous publication.';
  } else if (
    deliveries.some((d) => d.interventions.some((i) => i.resolution === null))
  ) {
    status = 'human-decision';
    pendingSince = null;
    nextStep =
      'Inspect delivery interventions; a human must resolve scope, budget or authority before work continues.';
  } else if (run?.status === 'needs-reconcile') {
    status = 'needs-reconciliation';
    pendingSince = run.updatedAt;
    nextStep =
      'Inspect the coding run and use its reconciliation control before starting another attempt.';
  } else if (assessment) {
    status = `assessment-${assessment.state}`;
    pendingSince = assessment.reservedAt;
    nextStep =
      assessment.state === 'uncertain'
        ? 'Reconcile the retained progress assessment; do not grant a replacement budget.'
        : 'Wait for the bounded progress assessment; inspect worker health if its deadline has passed.';
  } else if (
    run &&
    ['reserved', 'running', 'collecting'].includes(run.status)
  ) {
    status = `coding-${run.status}`;
    pendingSince = run.updatedAt;
    nextStep =
      'Inspect the coding run and coding worker health. Cancellation and reconciliation remain explicit operator actions.';
  } else if (budgets.some((b) => b.remainingExecutionMs === 0)) {
    status = 'budget-exhausted';
    pendingSince = null;
    nextStep =
      'Review remaining reservations and delivery evidence. Continuing requires a human budget decision; diagnosis does not refill budgets.';
  } else if (deliveries.length) {
    status = 'delivery-pending';
    pendingSince = null;
    nextStep =
      'Inspect current delivery evidence and delivery worker health. The coordinator advances only within the recorded human grant.';
  } else if (writeback.length) {
    status = 'writeback-pending';
    pendingSince = writeback.reduce(
      (old, e) => (e.createdAt < old ? e.createdAt : old),
      writeback[0].createdAt,
    );
    nextStep =
      'Inspect GitHub writeback effects and the recorded retry time; uncertain sends require reconciliation.';
  } else if (planning) {
    status = `planning-${planning.stage}`;
    pendingSince = planning.createdAt;
    nextStep =
      'Inspect the bound planning submission. A created request does not prove that model execution is still running.';
  } else if (run?.status === 'candidate') {
    status = 'candidate';
    pendingSince = null;
    nextStep =
      'Inspect the retained candidate. Delivery requires a separate human grant; a release alone does not authorize publication.';
  } else if (run?.status === 'failed' || run?.status === 'cancelled') {
    status = `coding-${run.status}`;
    pendingSince = null;
    nextStep =
      'Inspect retained coding evidence and resolve the failure or cancellation before deciding on further work.';
  } else if (r.work.lifecycle === 'queued') {
    nextStep =
      'Inspect coding readiness and coding worker health. A valid exact release and enabled local adapter are required for admission.';
  } else if (r.work.lifecycle === 'paused') {
    nextStep =
      'Review the task and its recorded decisions before explicitly resuming it.';
  }
  return v.parse(factoryTaskDiagnosisSchema, {
    workId: r.work.id,
    status,
    pendingSince,
    pendingAgeMs:
      pendingSince === null
        ? null
        : Math.max(0, now - Date.parse(pendingSince)),
    nextRetryAt:
      nextRetry === undefined ? null : new Date(nextRetry).toISOString(),
    nextStep,
    budgets,
    unresolvedEffects: effects.slice(0, 200),
    truncated: r.truncated || effects.length > 200,
  });
}
export function diagnoseHealth(
  records: TaskRecords[],
  workers: FactoryWorkerHealth[],
  generatedAt: string,
  truncated = false,
) {
  const tasks = records.map((r) => diagnoseTask(r, Date.parse(generatedAt)));
  const notRunning = workers.every((w) =>
    ['not-running', 'stopped'].includes(w.status),
  );
  const incomplete = truncated || tasks.some((t) => t.truncated);
  const attention =
    incomplete ||
    workers.some(
      (w) =>
        ['stale', 'stopped', 'not-running'].includes(w.status) ||
        w.consecutiveFailures > 0 ||
        w.diagnosticsDegraded,
    ) ||
    tasks.some((t) =>
      [
        'needs-reconciliation',
        'human-decision',
        'budget-exhausted',
        'coding-failed',
      ].includes(t.status),
    );
  const status = notRunning
    ? 'not-running'
    : attention
      ? 'attention'
      : 'healthy';
  const summary = incomplete
    ? 'Diagnosis is partial: additional tasks or current records were omitted. Inspect task-specific health before concluding there are no faults.'
    : status === 'not-running'
      ? 'Factory workers are not running. Start the configured Neondeck server to resume enabled workers; inspect task-specific gates before expecting progress.'
      : status === 'attention'
        ? 'Factory needs operator attention. Inspect stale or failing workers and task-specific next steps.'
        : 'No fault detected in the bounded local records. Task-specific human gates and pending work may still require action.';
  return v.parse(factoryHealthSchema, {
    generatedAt,
    status,
    summary,
    workers,
    tasks,
    truncated: incomplete,
  });
}
