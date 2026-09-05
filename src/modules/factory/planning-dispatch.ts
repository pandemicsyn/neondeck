import { factoryState, getFactoryWork } from './service';
import { AgentRunError, dispatch, init } from '@flue/runtime';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  getPlanningIntent,
  prepareFactoryTriage,
  pendingPlanningIntents,
  updatePlanningIntent,
  type PlanningIntent,
} from './planning-store';
export type PlanningTransport = {
  dispatch(
    intent: PlanningIntent,
    stage: 'triage' | 'planner',
  ): Promise<{ submissionId: string }>;
  abort(intent: PlanningIntent, stage: 'triage' | 'planner'): Promise<void>;
  read(
    intent: PlanningIntent,
    stage: 'triage' | 'planner',
    submissionId: string,
  ): Promise<void>;
};
const transport: PlanningTransport = {
  async dispatch(intent, stage) {
    const { FactoryPlanner, FactoryTriage } =
      await import('../../agents/factory-planner');
    return dispatch(stage === 'triage' ? FactoryTriage : FactoryPlanner, {
      id: stage === 'triage' ? `factory-triage-${intent.id}` : intent.sessionId,
      idempotencyKey: `factory:${intent.id}:${stage}`,
      message: {
        kind: 'signal',
        type: 'neondeck.factory.request',
        tagName:
          stage === 'planner' ? 'factory-human-message' : 'factory-triage',
        attributes: { intentId: intent.id, actor: 'local-operator' },
        body:
          stage === 'triage'
            ? JSON.stringify({
                title: intent.snapshot.source.title,
                body: intent.snapshot.source.body.slice(0, 8000),
                repoId: intent.snapshot.work.repoId,
                candidates: intent.triageCandidates,
              })
            : intent.message,
      },
    });
  },
  async abort(intent, stage) {
    const { FactoryPlanner, FactoryTriage } =
      await import('../../agents/factory-planner');
    await init(stage === 'triage' ? FactoryTriage : FactoryPlanner, {
      id: stage === 'triage' ? `factory-triage-${intent.id}` : intent.sessionId,
    }).abort();
  },
  async read(intent, stage, submissionId) {
    const { FactoryPlanner, FactoryTriage } =
      await import('../../agents/factory-planner');
    await init(stage === 'triage' ? FactoryTriage : FactoryPlanner, {
      id: stage === 'triage' ? `factory-triage-${intent.id}` : intent.sessionId,
    }).read(submissionId);
  },
};
// Only tracks attached local promises. Durable queue/leases/retries belong to Flue.
const attached = new Map<string, Promise<void>>();
export function resumeFactoryPlanning(
  intentId: string,
  paths: RuntimePaths = runtimePaths(),
  io: PlanningTransport = transport,
) {
  const key = `${paths.neondeckDatabase}:${intentId}`;
  const existing = attached.get(key);
  if (existing) return existing;
  const promise = run().finally(() => attached.delete(key));
  attached.set(key, promise);
  return promise;
  async function run() {
    for (;;) {
      let intent = getPlanningIntent(intentId, paths);
      if (intent.stage !== 'triage' && intent.stage !== 'planner') return;
      const stage = intent.stage;
      let submissionId =
        stage === 'triage' ? intent.triageSubmissionId : intent.submissionId;
      try {
        if (!submissionId) {
          // Retrying this exact persisted payload/key reconciles admission uncertainty.
          const receipt = await io.dispatch(intent, stage);
          submissionId = receipt.submissionId;
          intent = updatePlanningIntent(
            intentId,
            (row) => {
              if (stage === 'triage')
                row.triageSubmissionId = receipt.submissionId;
              else row.submissionId = receipt.submissionId;
              row.error = null;
            },
            paths,
          );
        }
        intent = getPlanningIntent(intentId, paths);
        if (intent.abortRequested) await io.abort(intent, stage);
        await io.read(intent, stage, submissionId);
        updatePlanningIntent(
          intentId,
          (row) => {
            if (row.stage !== stage) return;
            if (row.abortRequested) {
              row.stage = 'failed';
              row.error =
                'Planning stopped by the human. Send a new request to continue.';
            } else if (stage === 'triage' && !row.triage) {
              row.stage = 'failed';
              row.error =
                'Triage did not produce a valid result. Retry planning or edit the draft manually.';
            } else
              row.stage =
                stage === 'triage' && !row.triageOnly ? 'planner' : 'completed';
          },
          paths,
        );
        if (intent.triageOnly) {
          const next = prepareFactoryTriage(intent.workId, paths);
          if (next && next.id !== intent.id)
            void resumeFactoryPlanning(next.id, paths, io);
        }
      } catch (error) {
        updatePlanningIntent(
          intentId,
          (row) => {
            if (row.stage !== stage) return;
            // Unknown transport outcomes retain intent and key. Never reclassify
            // uncertainty as a new model request.
            if (error instanceof AgentRunError) row.stage = 'failed';
            row.error =
              error instanceof AgentRunError
                ? 'Model request failed, was stopped, or exhausted its budget. Retry with a new request or edit the draft manually.'
                : 'Dispatch or receipt recovery is pending. Retry recovery to reconcile the same request.';
          },
          paths,
        );
        if (intent.triageOnly && error instanceof AgentRunError) {
          const next = prepareFactoryTriage(intent.workId, paths);
          if (next && next.id !== intent.id)
            void resumeFactoryPlanning(next.id, paths, io);
        }
        return;
      }
    }
  }
}
export function recoverFactoryPlanning(
  paths = runtimePaths(),
  io: PlanningTransport = transport,
) {
  const state = factoryState(paths);
  if (state.enabled)
    for (const item of state.items) {
      if (item.lifecycle === 'inbox' && item.specVersion === 1)
        prepareFactoryTriage(item.id, paths);
    }
  for (const intent of pendingPlanningIntents(paths))
    void resumeFactoryPlanning(intent.id, paths, io);
}
export function recoverFactoryWorkPlanning(
  workId: string,
  paths = runtimePaths(),
  io: PlanningTransport = transport,
) {
  const current = getFactoryWork(workId, paths);
  if (current.work.lifecycle === 'inbox' && current.work.specVersion === 1)
    prepareFactoryTriage(workId, paths);
  for (const intent of pendingPlanningIntents(paths, workId))
    void resumeFactoryPlanning(intent.id, paths, io);
}
export async function stopFactoryPlanning(
  sessionId: string,
  paths = runtimePaths(),
) {
  const intents = pendingPlanningIntents(paths).filter(
    (i) => i.sessionId === sessionId,
  );
  for (const intent of intents) {
    // Fence model writes immediately; retain a durable abort intent until Flue settles.
    updatePlanningIntent(
      intent.id,
      (row) => {
        row.abortRequested = true;
        row.error = 'Stopping planning…';
      },
      paths,
    );
    if (intent.triageSubmissionId || intent.submissionId) {
      await transport.abort(intent, intent.stage as 'triage' | 'planner');
    }
    void resumeFactoryPlanning(intent.id, paths);
  }
}

export function triageAdmittedFactoryWork(
  workId: string,
  paths = runtimePaths(),
  retry = false,
) {
  const intent = prepareFactoryTriage(workId, paths, retry);
  if (intent) void resumeFactoryPlanning(intent.id, paths);
}
