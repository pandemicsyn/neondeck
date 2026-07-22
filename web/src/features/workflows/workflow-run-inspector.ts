import type { WorkflowRunRecord } from '../../api';

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
