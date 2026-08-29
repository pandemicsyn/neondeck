import { useFlueAgent, type UseFlueAgentResult } from '@flue/react';
import {
  createContext,
  useEffect,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  isPrReviewerDraftToolName,
  isPrReviewerPublishTourToolName,
  prReviewerConversationId,
} from '../../../../shared/pr-reviewer-session';
import type { PrReviewRecord } from '../../api';
import type { PrReviewTour } from '../../../../shared/pr-review-tour';
import type { PrReviewTourStep } from '../../../../shared/pr-review-tour';
import { ChatTimelineItems } from '../flue-chat/components/chat-timeline';
import { renderMessagePart } from '../flue-chat/components/message-parts';
import { chatMessagesForRender } from '../flue-chat/lib/messages';
import { sessionTimelineItems } from '../flue-chat/lib/timeline';
import { useChatAutoScroll } from '../flue-chat/lib/use-chat-auto-scroll';
import { createNeondeckConversationClient } from '../../lib/flue';
import { PrReviewTourToolPart } from './PrReviewTour';

export type PrReviewReviewerRequest = {
  id: number;
  conversationId: string;
  message: string;
  delivery: 'pending' | 'sending' | 'sent' | 'failed';
  error: string | null;
};

type ReviewerConversationContextValue = {
  agent: UseFlueAgentResult;
  agentId: string;
  connectionError: string | null;
  isLocked: boolean;
  ready: boolean;
  request: PrReviewReviewerRequest | null;
  sendError: string | null;
  sending: boolean;
  onReconnect: () => void;
  retryRequest: () => void;
  sendMessage: (message: string) => Promise<boolean>;
};

type ReviewerConversationStore = ReturnType<
  typeof createReviewerConversationStore
>;

const ReviewerConversationContext = createContext<
  ReviewerConversationStore | undefined
>(undefined);

function createReviewerConversationStore() {
  let snapshot: ReviewerConversationContextValue | null = null;
  const listeners = new Set<() => void>();
  return {
    clear() {
      if (snapshot === null) return;
      snapshot = null;
      for (const listener of listeners) listener();
    },
    getSnapshot: () => snapshot,
    publish(value: ReviewerConversationContextValue) {
      if (snapshot === value) return;
      snapshot = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const emptyConversationSnapshot = () => null;
const subscribeToNoConversation = () => () => undefined;

type ReviewerConversationOwnerProps = {
  isLocked?: boolean;
  onDraftChanged?: () => void;
  onRequestDeliveryChange?: (
    id: number,
    delivery: PrReviewReviewerRequest['delivery'],
    error?: string | null,
  ) => void;
  onSubmissionIdentified?: (submissionId: string) => void;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
  onTourPublished?: (tourId: string, generation: number) => void;
  request: PrReviewReviewerRequest | null;
  review: PrReviewRecord | null;
};

export function PrReviewReviewerConversationProvider({
  children,
  ...props
}: ReviewerConversationOwnerProps & { children: ReactNode }) {
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const handleReconnect = useCallback(
    () => setConnectionAttempt((attempt) => attempt + 1),
    [],
  );
  const review = props.review;
  const agentId =
    review?.status === 'ready'
      ? prReviewerConversationId(review.id, review.headSha)
      : null;
  const ownerKey = `${agentId ?? 'unavailable'}:${connectionAttempt}`;
  const conversationStore = useMemo(() => {
    void ownerKey;
    return createReviewerConversationStore();
  }, [ownerKey]);
  return (
    <ReviewerConversationContext.Provider value={conversationStore}>
      {agentId ? (
        <ReviewerControllerConnection
          agentId={agentId}
          conversationStore={conversationStore}
          isLocked={props.isLocked ?? false}
          key={`${agentId}:${connectionAttempt}`}
          onDraftChanged={props.onDraftChanged}
          onRequestDeliveryChange={props.onRequestDeliveryChange}
          onReconnect={handleReconnect}
          onSubmissionIdentified={props.onSubmissionIdentified}
          onSubmissionSettled={props.onSubmissionSettled}
          onTourPublished={props.onTourPublished}
          request={
            props.request?.conversationId === agentId ? props.request : null
          }
        />
      ) : null}
      {children}
    </ReviewerConversationContext.Provider>
  );
}

export function PrReviewReviewerController({
  isLocked = false,
  onDraftChanged,
  onRequestDeliveryChange,
  onSubmissionIdentified,
  onSubmissionSettled,
  onTourPublished,
  request,
  review,
}: {
  isLocked?: boolean;
  onDraftChanged?: () => void;
  onRequestDeliveryChange?: (
    id: number,
    delivery: PrReviewReviewerRequest['delivery'],
    error?: string | null,
  ) => void;
  onSubmissionIdentified?: (submissionId: string) => void;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
  onTourPublished?: (tourId: string, generation: number) => void;
  request: PrReviewReviewerRequest | null;
  review: PrReviewRecord | null;
}) {
  return (
    <PrReviewReviewerConversationProvider
      isLocked={isLocked}
      onDraftChanged={onDraftChanged}
      onRequestDeliveryChange={onRequestDeliveryChange}
      onSubmissionIdentified={onSubmissionIdentified}
      onSubmissionSettled={onSubmissionSettled}
      onTourPublished={onTourPublished}
      request={request}
      review={review}
    >
      {null}
    </PrReviewReviewerConversationProvider>
  );
}

function ReviewerControllerConnection({
  agentId,
  conversationStore,
  isLocked,
  onDraftChanged,
  onRequestDeliveryChange,
  onReconnect,
  onSubmissionIdentified,
  onSubmissionSettled,
  onTourPublished,
  request,
}: {
  agentId: string;
  conversationStore: ReviewerConversationStore;
  isLocked: boolean;
  onDraftChanged?: () => void;
  onRequestDeliveryChange?: (
    id: number,
    delivery: PrReviewReviewerRequest['delivery'],
    error?: string | null,
  ) => void;
  onReconnect: () => void;
  onSubmissionIdentified?: (submissionId: string) => void;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
  onTourPublished?: (tourId: string, generation: number) => void;
  request: PrReviewReviewerRequest | null;
}) {
  const identifiedSubmissionIdsRef = useRef(new Set<string>());
  const observedSettlementsRef = useRef(new Set<string>());
  const settlementsRef = useRef<UseFlueAgentResult['settlements']>([]);
  const onSubmissionIdentifiedRef = useRef(onSubmissionIdentified);
  onSubmissionIdentifiedRef.current = onSubmissionIdentified;
  const onSubmissionSettledRef = useRef(onSubmissionSettled);
  onSubmissionSettledRef.current = onSubmissionSettled;
  const conversationClient = useMemo(
    () =>
      createNeondeckConversationClient('pr-reviewer', agentId, {
        onAdmission: (admission) => {
          if (identifiedSubmissionIdsRef.current.has(admission.submissionId)) {
            return;
          }
          identifiedSubmissionIdsRef.current.add(admission.submissionId);
          onSubmissionIdentifiedRef.current?.(admission.submissionId);
          observeLocalSettlements({
            settlements: settlementsRef.current,
            identifiedSubmissionIds: identifiedSubmissionIdsRef.current,
            observedSettlements: observedSettlementsRef.current,
            onSubmissionSettled: onSubmissionSettledRef.current,
          });
        },
      }),
    [agentId],
  );
  const agent = useFlueAgent({ client: conversationClient });
  settlementsRef.current = agent.settlements;
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const observedDraftToolCalls = useRef(new Set<string>());
  const observedTourToolCalls = useRef(new Set<string>());
  const tourHistorySeeded = useRef(false);
  const startedRequestIdsRef = useRef(new Set<number>());
  const connectionError = agent.error?.message ?? null;
  const busy =
    sending || request?.delivery === 'sending' || agent.status === 'connecting';
  const ready = agent.historyReady && !connectionError && !busy && !isLocked;

  const sendMessage = useCallback(
    async (message: string) => {
      const body = message.trim();
      if (!body || !ready) return false;
      setSendError(null);
      setSending(true);
      try {
        await agent.sendMessage(body);
        return true;
      } catch (cause) {
        setSendError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setSending(false);
      }
    },
    [agent, ready],
  );

  useEffect(() => {
    let changed = false;
    for (const message of agent.messages) {
      for (const part of message.parts) {
        if (
          part.type === 'dynamic-tool' &&
          part.state === 'output-available' &&
          typeof part.toolName === 'string' &&
          typeof part.toolCallId === 'string' &&
          isPrReviewerDraftToolName(part.toolName) &&
          !observedDraftToolCalls.current.has(part.toolCallId)
        ) {
          observedDraftToolCalls.current.add(part.toolCallId);
          if (draftMutationSucceeded(part.output)) changed = true;
        }
      }
    }
    if (changed) onDraftChanged?.();
  }, [agent.messages, onDraftChanged]);

  useEffect(() => {
    if (!request || request.delivery !== 'pending') return;
    if (agent.error) {
      onRequestDeliveryChange?.(
        request.id,
        'failed',
        `Reviewer connection unavailable: ${agent.error.message}`,
      );
      return;
    }
    if (!ready) return;
    if (startedRequestIdsRef.current.has(request.id)) return;
    startedRequestIdsRef.current.add(request.id);
    onRequestDeliveryChange?.(request.id, 'sending');
    void agent
      .sendMessage(request.message)
      .then(() => onRequestDeliveryChange?.(request.id, 'sent'))
      .catch((cause) => {
        startedRequestIdsRef.current.delete(request.id);
        onRequestDeliveryChange?.(
          request.id,
          'failed',
          cause instanceof Error ? cause.message : String(cause),
        );
      });
  }, [agent, agent.error, onRequestDeliveryChange, ready, request]);

  useEffect(() => {
    observeLocalSettlements({
      settlements: agent.settlements,
      identifiedSubmissionIds: identifiedSubmissionIdsRef.current,
      observedSettlements: observedSettlementsRef.current,
      onSubmissionSettled,
    });
  }, [agent.settlements, onSubmissionSettled]);

  useEffect(() => {
    const seedTourHistory = agent.historyReady && !tourHistorySeeded.current;
    for (const message of agent.messages) {
      for (const part of message.parts) {
        if (
          part.type !== 'dynamic-tool' ||
          part.state !== 'output-available' ||
          typeof part.toolName !== 'string' ||
          typeof part.toolCallId !== 'string' ||
          !isPrReviewerPublishTourToolName(part.toolName) ||
          observedTourToolCalls.current.has(part.toolCallId)
        ) {
          continue;
        }
        observedTourToolCalls.current.add(part.toolCallId);
        const publication = successfulTourPublication(part.output);
        if (publication && !seedTourHistory) {
          onTourPublished?.(publication.tourId, publication.generation);
        }
      }
    }
    if (seedTourHistory) tourHistorySeeded.current = true;
  }, [agent.historyReady, agent.messages, onTourPublished]);

  const context = useMemo<ReviewerConversationContextValue>(
    () => ({
      agent,
      agentId,
      connectionError,
      isLocked,
      onReconnect,
      ready,
      request,
      retryRequest: () => {
        if (!request || request.delivery !== 'failed') return;
        onReconnect();
        onRequestDeliveryChange?.(request.id, 'pending', null);
      },
      sendError,
      sending,
      sendMessage,
    }),
    [
      agent,
      agentId,
      connectionError,
      isLocked,
      onReconnect,
      onRequestDeliveryChange,
      ready,
      request,
      sendError,
      sendMessage,
      sending,
    ],
  );

  useEffect(() => {
    conversationStore.publish(context);
  }, [context, conversationStore]);
  useEffect(() => () => conversationStore.clear(), [conversationStore]);

  return null;
}

function observeLocalSettlements({
  settlements,
  identifiedSubmissionIds,
  observedSettlements,
  onSubmissionSettled,
}: {
  settlements: UseFlueAgentResult['settlements'];
  identifiedSubmissionIds: Set<string>;
  observedSettlements: Set<string>;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
}) {
  for (const settlement of settlements) {
    if (
      observedSettlements.has(settlement.submissionId) ||
      !identifiedSubmissionIds.has(settlement.submissionId)
    ) {
      continue;
    }
    observedSettlements.add(settlement.submissionId);
    onSubmissionSettled?.(settlement.submissionId, settlement.outcome);
  }
}

export function PrReviewReviewerChat({
  isLocked = false,
  onDraftChanged,
  review,
  tour = null,
  tourClosed = false,
  activeTourStepId = null,
  onActivateTourStep,
  onAskTourStep,
  onCloseTour,
  onOpenTour,
  onBackToTourFinding,
  onTourPublished,
  onRequestDeliveryChange,
  onSubmissionIdentified,
  onSubmissionSettled,
  onSendMessage,
  request = null,
}: {
  isLocked?: boolean;
  onDraftChanged?: () => void;
  review: PrReviewRecord | null;
  tour?: PrReviewTour | null;
  tourClosed?: boolean;
  activeTourStepId?: string | null;
  onActivateTourStep?: (step: PrReviewTourStep) => void;
  onAskTourStep?: (step: PrReviewTourStep) => void;
  onCloseTour?: () => void;
  onOpenTour?: () => void;
  onBackToTourFinding?: (() => void) | null;
  onTourPublished?: (tourId: string, generation: number) => void;
  onRequestDeliveryChange?: (
    id: number,
    delivery: PrReviewReviewerRequest['delivery'],
    error?: string | null,
  ) => void;
  onSubmissionIdentified?: (submissionId: string) => void;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
  onSendMessage?: (message: string) => void;
  request?: PrReviewReviewerRequest | null;
}) {
  const conversationStore = useContext(ReviewerConversationContext);
  const conversation = useSyncExternalStore(
    conversationStore?.subscribe ?? subscribeToNoConversation,
    conversationStore?.getSnapshot ?? emptyConversationSnapshot,
    emptyConversationSnapshot,
  );
  const composerIdentity = review
    ? `${review.id}:${review.headSha}`
    : 'unavailable';
  const [input, setInput] = useState('');
  useEffect(() => setInput(''), [composerIdentity]);

  if (!review) {
    return (
      <ReviewerUnavailable copy="Run Neon on this PR to open a reviewer conversation." />
    );
  }
  if (review.status === 'reviewing') {
    return (
      <ReviewerUnavailable copy="Neon is reviewing the current PR revision. The reviewer conversation will reconnect when it finishes." />
    );
  }
  if (review.status === 'failed') {
    return (
      <ReviewerUnavailable copy="The Neon review run failed. Retry it before asking follow-up questions." />
    );
  }
  if (review.status !== 'ready') {
    return (
      <ReviewerUnavailable copy="The reviewer conversation is no longer active for this submitted review." />
    );
  }

  if (!conversationStore) {
    return (
      <PrReviewReviewerConversationProvider
        isLocked={isLocked}
        onDraftChanged={onDraftChanged}
        onRequestDeliveryChange={onRequestDeliveryChange}
        onSubmissionIdentified={onSubmissionIdentified}
        onSubmissionSettled={onSubmissionSettled}
        onTourPublished={onTourPublished}
        request={request}
        review={review}
      >
        <PrReviewReviewerChat
          activeTourStepId={activeTourStepId}
          isLocked={isLocked}
          onActivateTourStep={onActivateTourStep}
          onAskTourStep={onAskTourStep}
          onBackToTourFinding={onBackToTourFinding}
          onCloseTour={onCloseTour}
          onDraftChanged={onDraftChanged}
          onOpenTour={onOpenTour}
          onRequestDeliveryChange={onRequestDeliveryChange}
          onSendMessage={onSendMessage}
          onSubmissionIdentified={onSubmissionIdentified}
          onSubmissionSettled={onSubmissionSettled}
          onTourPublished={onTourPublished}
          request={request}
          review={review}
          tour={tour}
          tourClosed={tourClosed}
        />
      </PrReviewReviewerConversationProvider>
    );
  }
  if (!conversation) {
    return <ReviewerUnavailable copy="Connecting to the PR reviewer…" />;
  }
  if (
    conversation.agentId !== prReviewerConversationId(review.id, review.headSha)
  ) {
    return <ReviewerUnavailable copy="Connecting to the PR reviewer…" />;
  }
  return (
    <ReviewerConversation
      conversation={conversation}
      tour={tour}
      tourClosed={tourClosed}
      activeTourStepId={activeTourStepId}
      onActivateTourStep={onActivateTourStep}
      onAskTourStep={onAskTourStep}
      onCloseTour={onCloseTour}
      onOpenTour={onOpenTour}
      onBackToTourFinding={onBackToTourFinding}
      onSendMessage={onSendMessage}
      input={input}
      setInput={setInput}
    />
  );
}

function ReviewerConversation({
  conversation,
  tour,
  tourClosed,
  activeTourStepId,
  onActivateTourStep,
  onAskTourStep,
  onCloseTour,
  onOpenTour,
  onBackToTourFinding,
  onSendMessage,
  input,
  setInput,
}: {
  conversation: ReviewerConversationContextValue;
  tour: PrReviewTour | null;
  tourClosed: boolean;
  activeTourStepId: string | null;
  onActivateTourStep?: (step: PrReviewTourStep) => void;
  onAskTourStep?: (step: PrReviewTourStep) => void;
  onCloseTour?: () => void;
  onOpenTour?: () => void;
  onBackToTourFinding?: (() => void) | null;
  onSendMessage?: (message: string) => void;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
}) {
  const {
    agent,
    agentId,
    connectionError,
    isLocked,
    onReconnect,
    ready,
    request,
    retryRequest,
    sendError,
    sending,
    sendMessage,
  } = conversation;
  const inputId = useId();
  const messages = useMemo(
    () => chatMessagesForRender(agent.messages),
    [agent.messages],
  );
  const items = useMemo(() => sessionTimelineItems(messages, []), [messages]);
  const autoScroll = useChatAutoScroll(agentId);
  const busy =
    sending || request?.delivery === 'sending' || agent.status === 'connecting';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || !ready) return;
    setInput('');
    if (onSendMessage) {
      onSendMessage(message);
      return;
    }
    if (!(await sendMessage(message))) {
      setInput((current) => current || message);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section className="pr-reviewer-chat" aria-label="Reviewer conversation">
      <div
        className="pr-reviewer-chat-timeline"
        onScroll={autoScroll.handleScroll}
        ref={autoScroll.transcriptRef}
      >
        {connectionError ? (
          <div className="pr-reviewer-chat-error" role="alert">
            <p>Reviewer connection failed</p>
            <span>{connectionError}</span>
          </div>
        ) : null}
        {items.length > 0 ? (
          <ChatTimelineItems
            hasSession
            items={items}
            renderPart={(part, key) =>
              renderReviewerPart(part, key, tour, tourClosed, {
                activeTourStepId,
                onActivateTourStep,
                onAskTourStep,
                onCloseTour,
                onOpenTour,
                onBackToTourFinding,
              })
            }
          />
        ) : connectionError ? null : (
          <div className="pr-reviewer-chat-empty">
            <p>Ask the reviewer</p>
            <span>
              Challenge a finding, request evidence, or ask about a specific
              path and line.
            </span>
          </div>
        )}
      </div>
      {autoScroll.hasNewActivity ? (
        <button
          className="pr-reviewer-chat-latest"
          onClick={autoScroll.jumpToLatest}
          type="button"
        >
          New response · jump to latest
        </button>
      ) : null}
      <form className="pr-reviewer-chat-form" onSubmit={submit}>
        {request?.delivery === 'failed' ? (
          <div className="pr-reviewer-chat-error" role="alert">
            <p>Reviewer request failed</p>
            <span>{request.error}</span>
            <button onClick={retryRequest} type="button">
              Retry
            </button>
          </div>
        ) : null}
        <label className="sr-only" htmlFor={inputId}>
          Ask the reviewer a question
        </label>
        <textarea
          aria-describedby={`${inputId}-shortcut`}
          disabled={!ready}
          id={inputId}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isLocked
              ? 'Wait for the PR revision update to finish.'
              : connectionError
                ? 'Reviewer connection unavailable.'
                : agent.historyReady
                  ? busy
                    ? 'Connecting to reviewer…'
                    : 'Ask why this is an issue…'
                  : 'Loading reviewer history…'
          }
          rows={3}
          value={input}
        />
        <div className="pr-reviewer-chat-actions">
          <span aria-live="polite" id={`${inputId}-shortcut`}>
            {agent.status === 'streaming'
              ? 'Reviewer is responding · follow-ups are queued'
              : sendError || 'Enter send · Shift+Enter newline'}
          </span>
          {connectionError ? (
            <button disabled={isLocked} onClick={onReconnect} type="button">
              Reconnect
            </button>
          ) : (
            <button
              disabled={!ready || input.trim().length === 0}
              type="submit"
            >
              {sending ? 'Sending' : 'Ask'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function renderReviewerPart(
  part: unknown,
  key: string,
  tour: PrReviewTour | null,
  tourClosed: boolean,
  controls: {
    activeTourStepId: string | null;
    onActivateTourStep?: (step: PrReviewTourStep) => void;
    onAskTourStep?: (step: PrReviewTourStep) => void;
    onCloseTour?: () => void;
    onOpenTour?: () => void;
    onBackToTourFinding?: (() => void) | null;
  },
): ReactNode {
  if (
    part &&
    typeof part === 'object' &&
    'type' in part &&
    part.type === 'dynamic-tool' &&
    'toolName' in part &&
    typeof part.toolName === 'string' &&
    isPrReviewerPublishTourToolName(part.toolName)
  ) {
    return (
      <PrReviewTourToolPart
        activeTour={tour}
        activeStepId={controls.activeTourStepId}
        closed={tourClosed}
        key={key}
        part={part}
        onActivate={controls.onActivateTourStep}
        onAsk={controls.onAskTourStep}
        onClose={controls.onCloseTour}
        onOpen={controls.onOpenTour}
        onBackToFinding={controls.onBackToTourFinding}
      />
    );
  }
  return renderMessagePart(part, key);
}

function draftMutationSucceeded(output: unknown) {
  return Boolean(
    output &&
    typeof output === 'object' &&
    'ok' in output &&
    output.ok === true,
  );
}

function successfulTourPublication(output: unknown) {
  if (!output || typeof output !== 'object') return null;
  const value = output as Record<string, unknown>;
  return value.ok === true &&
    typeof value.tourId === 'string' &&
    typeof value.generation === 'number'
    ? { tourId: value.tourId, generation: value.generation }
    : null;
}

function ReviewerUnavailable({ copy }: { copy: string }) {
  return <p className="pr-reviewer-chat-unavailable">{copy}</p>;
}
