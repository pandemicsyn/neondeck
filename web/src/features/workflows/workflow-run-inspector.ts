import type {
  WorkflowEventRecord,
  WorkflowRunInspectionResponse,
  WorkflowRunRecord,
} from '../../api';

export const activeWorkflowRunRefreshMs = 2_000;
export const terminalWorkflowRunRefreshMs = 1_000;
export const terminalWorkflowRunSettleGraceMs = 10_000;

export type WorkflowRunPayload = {
  label: 'error' | 'result' | 'input';
  value: unknown;
  tone: 'normal' | 'error';
};

export function workflowRunPayloads(
  run: WorkflowRunRecord,
): WorkflowRunPayload[] {
  const payloads: WorkflowRunPayload[] = [];
  if (run.error !== undefined) {
    payloads.push({ label: 'error', value: run.error, tone: 'error' });
  }
  if (run.result !== undefined) {
    payloads.push({ label: 'result', value: run.result, tone: 'normal' });
  }
  if (run.input !== undefined) {
    payloads.push({ label: 'input', value: run.input, tone: 'normal' });
  }
  if (payloads.length === 0) {
    payloads.push({
      label: 'result',
      value: { status: 'No input, result, or error payload was recorded.' },
      tone: 'normal',
    });
  }
  return payloads;
}

export function formatWorkflowPayload(value: unknown) {
  if (value === undefined) return 'Not recorded';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function orderWorkflowRunEvents(events: WorkflowEventRecord[]) {
  return [...events].sort((left, right) => {
    if (left.eventIndex !== null && right.eventIndex !== null) {
      return left.eventIndex - right.eventIndex || left.id - right.id;
    }
    if (left.eventIndex !== null) return -1;
    if (right.eventIndex !== null) return 1;
    const timestampDifference =
      Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return timestampDifference || left.id - right.id;
  });
}

export type WorkflowRunRefreshDecision = {
  interval: number | false;
  terminalPendingSince: number | null;
};

export function workflowRunRefreshDecision(
  inspection: WorkflowRunInspectionResponse | undefined,
  terminalPendingSince: number | null,
  now: number,
): WorkflowRunRefreshDecision {
  if (!inspection) {
    return { interval: false, terminalPendingSince: null };
  }
  if (inspection.run.status === 'active') {
    return {
      interval: activeWorkflowRunRefreshMs,
      terminalPendingSince: null,
    };
  }
  if (inspection.events.some((event) => event.eventType === 'run_end')) {
    return { interval: false, terminalPendingSince: null };
  }

  const pendingSince = terminalPendingSince ?? now;
  return {
    interval:
      now - pendingSince < terminalWorkflowRunSettleGraceMs
        ? terminalWorkflowRunRefreshMs
        : false,
    terminalPendingSince: pendingSince,
  };
}
