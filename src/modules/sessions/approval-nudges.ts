import { addNotification } from '../app-state';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  createChatSessionCommandEvent,
  updateChatSessionCommandEvent,
} from './service';

export type ApprovalNudgeDecision = 'approved' | 'denied';

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
    await updateChatSessionCommandEvent(
      {
        sessionId: input.sessionId,
        eventId: created.event.id,
        status: 'completed',
        completedAt: new Date().toISOString(),
        reason: `${input.family}_approval_${input.decision}`,
        result: {
          ok: true,
          command: 'dev-doctor',
          input: message,
          status: 'completed',
          message,
        },
      },
      paths,
    ).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    });
  } else if (created && !created.ok) {
    errors.push(created.message);
  }

  await addNotification(
    {
      level: input.decision === 'approved' ? 'ready' : 'info',
      title:
        input.decision === 'approved'
          ? `${label} approval answered`
          : `${label} approval denied`,
      message,
      source: input.family,
      sourceId: `${input.family}-approval:${input.approvalId}:resolved`,
      data: {
        approvalId: input.approvalId,
        sessionId: input.sessionId,
        decision: input.decision,
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
