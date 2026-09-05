import type { FactoryDiscussionReference } from '../../../../shared/factory-planning';
import { ApiError } from '../../api/http';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { FactoryDetail } from '../../../../shared/factory';
import {
  getFactoryPlanning,
  retryFactoryTriage,
  sendFactoryPlanning,
  stopFactoryPlanning,
  recoverFactoryPlanning,
  refreshFactoryPlanningContext,
} from '../../api/factory';
import { FlueChatSessionView } from '../flue-chat/components/session-view';
export function FactoryPlanning({
  detail,
  discussion,
  onClearDiscussion,
}: {
  detail: FactoryDetail;
  discussion?: FactoryDiscussionReference;
  onClearDiscussion?: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<{
    key: string;
    message: string;
    version: number;
    discussion?: FactoryDiscussionReference;
  }>();
  const state = useQuery({
    queryKey: ['factory-planning', detail.work.id],
    queryFn: () => getFactoryPlanning(detail.work.id),
    refetchInterval: 1500,
  });
  const pending = state.data?.activity === 'pending';
  const blocked =
    busy ||
    pending ||
    state.data?.contextStale ||
    ['paused', 'closed', 'queued'].includes(detail.work.lifecycle);
  async function send(message: string) {
    const current =
      request?.message === message &&
      JSON.stringify(request.discussion) === JSON.stringify(discussion)
        ? request
        : {
            key: crypto.randomUUID(),
            message,
            version: detail.work.version,
            discussion,
          };
    setRequest(current);
    setBusy(true);
    setError('');
    try {
      await sendFactoryPlanning(detail.work.id, {
        requestKey: current.key,
        expectedVersion: current.version,
        message,
        ...(current.discussion ? { discussion: current.discussion } : {}),
      });
      setRequest(undefined);
      onClearDiscussion?.();
      await state.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        setRequest(undefined);
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await run();
      await state.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planning request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="factory-planning" aria-label="Planning conversation">
      <h3>Shape with Neon</h3>
      {discussion && (
        <div className="factory-discussion-context">
          <strong>
            Discussing v{discussion.version} · {discussion.kind}:{' '}
            {discussion.id}
          </strong>
          <p>
            {discussion.version !== detail.work.specVersion
              ? 'This reference is from an older version. Feedback stays attached to that version.'
              : 'Your next message will include this exact revision and reference.'}{' '}
            Chat does not itself edit the brief or release work.
          </p>
          <button disabled={busy || pending} onClick={onClearDiscussion}>
            Clear discussion reference
          </button>
        </div>
      )}
      {state.isPending ? (
        <output>Loading planning state…</output>
      ) : state.error && !state.data ? (
        <p role="alert">
          Planning state unavailable.{' '}
          <button onClick={() => void state.refetch()}>Retry</button>
        </p>
      ) : (
        <>
          {state.error && state.data && (
            <p className="factory-error" role="alert">
              Planning refresh failed. Showing the last loaded state; your
              unsent reply is retained.{' '}
              <button onClick={() => void state.refetch()}>Retry</button>
            </p>
          )}
          {state.data?.triage && (
            <div>
              <p>
                <strong>Triage: {state.data.triage.disposition}</strong> ·{' '}
                {state.data.triage.priority}
                <br />
                {state.data.triage.summary}
              </p>
              {state.data.triage.missingInformation.length > 0 && (
                <ul>
                  {state.data.triage.missingInformation.map((info) => (
                    <li key={info}>{info}</li>
                  ))}
                </ul>
              )}
              {state.data.triage.candidateIds.map((id) => (
                <a key={id} href={`/factory?task=${encodeURIComponent(id)}`}>
                  Possible related task
                </a>
              ))}
            </div>
          )}
          {pending && (
            <>
              <output>Neon is working on this request…</output>
              <button
                disabled={busy}
                onClick={() =>
                  void action(() => stopFactoryPlanning(state.data!.sessionId!))
                }
              >
                Stop planning
              </button>
            </>
          )}
          {(error || state.data?.error) && (
            <p className="factory-error" role="alert">
              {error || state.data?.error}
            </p>
          )}
          {state.data?.error && pending && (
            <button
              onClick={() =>
                void action(() => recoverFactoryPlanning(detail.work.id))
              }
            >
              Retry recovery
            </button>
          )}
          {state.data?.sessionId && (
            <details>
              <summary>
                Planning context{' '}
                {state.data.contextStale ? '— refresh required' : ''}
              </summary>
              <p>
                Planner: {state.data.model}
                <br />
                Captured: {state.data.contextCapturedAt}
                <br />
                Triage model: {state.data.triageModel}
                <br />
                Triage receipt:{' '}
                {state.data.triageSubmissionId ?? 'Not admitted'}
              </p>
              <button
                disabled={busy || pending}
                onClick={() =>
                  void action(() =>
                    refreshFactoryPlanningContext(
                      detail.work.id,
                      detail.work.version,
                    ),
                  )
                }
              >
                Refresh planning context
              </button>
            </details>
          )}
          {!state.data?.plannerStarted ? (
            <>
              <p>
                Neon can recommend an approach and save a proposed brief. Review
                and release remain yours.
              </p>
              <button
                disabled={blocked}
                onClick={() =>
                  void action(() =>
                    send(
                      'Please triage this task and propose an initial brief, approach, and acceptance criteria. Record any blocking questions.',
                    ),
                  )
                }
              >
                Ask Neon to plan
              </button>
            </>
          ) : (
            <div className="factory-chat">
              <FlueChatSessionView
                key={state.data.sessionId}
                activeRecord={undefined}
                agentName="factory-planner"
                refreshKey={state.data.submissionId}
                allowCommands={false}
                messageEnabled={!blocked}
                messageLabel="Discuss this draft"
                draftStorageKey={`factory-chat-draft:${detail.work.id}:${state.data.sessionId}`}
                onSendMessage={send}
                quickCommands={[]}
                session={{
                  id: state.data.sessionId!,
                  label: 'Task planning',
                  placeholder:
                    'Answer a question or ask Neon to revise the plan…',
                }}
                sessionState={undefined}
              />
            </div>
          )}
          {state.data?.activity === 'failed' && !state.data.triage && (
            <button
              disabled={busy}
              onClick={() =>
                void action(() => retryFactoryTriage(detail.work.id))
              }
            >
              Retry triage only
            </button>
          )}
          {state.data?.activity === 'failed' && (
            <p>
              Send your reply to retry planning, or edit the draft manually.
            </p>
          )}
        </>
      )}
    </section>
  );
}
