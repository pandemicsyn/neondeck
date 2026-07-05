import { dispatch, type DispatchReceipt } from '@flue/runtime';
import { addNotification } from '../app-state';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  createChatSessionCommandEvent,
  updateChatSessionCommandEvent,
} from './service';

export type ApprovalNudgeDecision = 'approved' | 'denied';
type ApprovalNudgeDispatch = (input: {
  agent: 'display-assistant';
  id: string;
  input: string;
}) => Promise<DispatchReceipt>;

let approvalNudgeDispatch: ApprovalNudgeDispatch = (input) =>
  dispatch(input) as Promise<DispatchReceipt>;

export function setApprovalNudgeDispatchForTests(
  dispatchFn: ApprovalNudgeDispatch,
) {
  const previous = approvalNudgeDispatch;
  approvalNudgeDispatch = dispatchFn;
  return () => {
    approvalNudgeDispatch = previous;
  };
}

export async function createApprovalResolutionNudge(
  input: {
    family: 'execution' | 'mcp';
    sessionId: string | null | undefined;
    approvalId: string;
    decision: ApprovalNudgeDecision;
    subject: string;
    retryInstruction: string;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  if (!input.sessionId) {
    return { ok: true as const, skipped: true as const };
  }

  const label = input.family === 'execution' ? 'Execution' : 'MCP tool';
  const message =
    input.decision === 'approved'
      ? `${label} approval ${input.approvalId} approved for ${input.subject}. ${input.retryInstruction}`
      : `${label} approval ${input.approvalId} denied for ${input.subject}. Do not retry unless the user changes the decision.`;
  const errors: string[] = [];
  const dispatchReceipt = await approvalNudgeDispatch({
    agent: 'display-assistant',
    id: input.sessionId,
    input: message,
  }).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  });
  const created = await createChatSessionCommandEvent(
    {
      sessionId: input.sessionId,
      input: message,
      reason: `${input.family}_approval_${input.decision}`,
    },
    paths,
  ).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  });

  if (created?.ok && 'event' in created && created.event) {
    const eventStatus = dispatchReceipt ? 'completed' : 'failed';
    await updateChatSessionCommandEvent(
      {
        sessionId: input.sessionId,
        eventId: created.event.id,
        status: eventStatus,
        completedAt: new Date().toISOString(),
        reason: `${input.family}_approval_${input.decision}`,
        result: {
          ok: Boolean(dispatchReceipt),
          command: 'approval-nudge',
          input: message,
          status: dispatchReceipt ? 'completed' : 'failed',
          message: dispatchReceipt
            ? `${message} Flue accepted the answer for delivery.`
            : `${message} Flue dispatch did not accept the answer; use the approval row to retry manually.`,
          dispatchReceipt,
        },
      },
      paths,
    ).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
  } else if (created && !created.ok) {
    errors.push(created.message);
  }

  const dispatchAccepted = Boolean(dispatchReceipt);
  await addNotification(
    {
      level: dispatchAccepted
        ? input.decision === 'approved'
          ? 'ready'
          : 'info'
        : 'attention',
      title: dispatchAccepted
        ? input.decision === 'approved'
          ? `${label} approval answered`
          : `${label} approval denied`
        : `${label} approval delivery failed`,
      message,
      source: input.family,
      sourceId: `${input.family}-approval:${input.approvalId}:resolved`,
      data: {
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        decision: input.decision,
        dispatchAccepted,
        dispatchReceipt,
      },
    },
    paths,
  ).catch((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  });

  return {
    ok: errors.length === 0,
    skipped: false as const,
    errors,
  };
}
