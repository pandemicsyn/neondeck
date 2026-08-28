import { useFlueAgent, type UseFlueAgentResult } from '@flue/react';
import {
  useEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
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
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  if (!review || review.status !== 'ready') return null;
  const agentId = prReviewerConversationId(review.id, review.headSha);
  return (
    <ReviewerControllerConnection
      agentId={agentId}
      isLocked={isLocked}
      key={`${agentId}:${connectionAttempt}`}
      onDraftChanged={onDraftChanged}
      onRequestDeliveryChange={onRequestDeliveryChange}
      onReconnect={() => setConnectionAttempt((attempt) => attempt + 1)}
      onSubmissionIdentified={onSubmissionIdentified}
      onSubmissionSettled={onSubmissionSettled}
      onTourPublished={onTourPublished}
      request={request?.conversationId === agentId ? request : null}
    />
  );
}

function ReviewerControllerConnection({
  agentId,
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
  const conversationClient = useMemo(
    () => createNeondeckConversationClient('pr-reviewer', agentId),
    [agentId],
  );
  const agent = useFlueAgent({ client: conversationClient });
  const observedDraftToolCalls = useRef(new Set<string>());
  const observedTourToolCalls = useRef(new Set<string>());
  const tourHistorySeeded = useRef(false);
  const pendingLocalClaimMessagesRef = useRef<string[]>([]);
  const knownLocalMessageIdsRef = useRef(new Set<string>());
  const claimedLocalMessageIdsRef = useRef(new Set<string>());
  const identifiedSubmissionIdsRef = useRef(new Set<string>());
  const observedSettlementsRef = useRef(new Set<string>());
  const startedRequestIdsRef = useRef(new Set<number>());
  const ready = agent.historyReady && !agent.error && !isLocked;

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
    for (const message of agent.messages) {
      if (message.role === 'user' && message.id.startsWith('local:')) {
        knownLocalMessageIdsRef.current.add(message.id);
      }
    }
    pendingLocalClaimMessagesRef.current.push(request.message);
    onRequestDeliveryChange?.(request.id, 'sending');
    void agent
      .sendMessage(request.message)
      .then(() => onRequestDeliveryChange?.(request.id, 'sent'))
      .catch((cause) =>
        onRequestDeliveryChange?.(
          request.id,
          'failed',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
  }, [agent, agent.error, onRequestDeliveryChange, ready, request]);

  useEffect(() => {
    observeLocalSubmissions({
      agent,
      claimedLocalMessageIds: claimedLocalMessageIdsRef.current,
      identifiedSubmissionIds: identifiedSubmissionIdsRef.current,
      knownLocalMessageIds: knownLocalMessageIdsRef.current,
      onSubmissionIdentified,
      pendingLocalClaimMessages: pendingLocalClaimMessagesRef.current,
    });
  }, [agent, agent.failedSends, agent.messages, onSubmissionIdentified]);

  useEffect(() => {
    observeLocalSettlements({
      agent,
      identifiedSubmissionIds: identifiedSubmissionIdsRef.current,
      observedSettlements: observedSettlementsRef.current,
      onSubmissionSettled,
    });
  }, [agent, agent.settlements, onSubmissionSettled]);

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

  return request?.delivery === 'failed' ? (
    <div className="pr-reviewer-chat-error" role="alert">
      <p>Reviewer request failed</p>
      <span>{request.error}</span>
      <button
        onClick={() => {
          onReconnect();
          onRequestDeliveryChange?.(request.id, 'pending', null);
        }}
        type="button"
      >
        Retry
      </button>
    </div>
  ) : null;
}

function observeLocalSubmissions({
  agent,
  claimedLocalMessageIds,
  identifiedSubmissionIds,
  knownLocalMessageIds,
  onSubmissionIdentified,
  pendingLocalClaimMessages,
}: {
  agent: UseFlueAgentResult;
  claimedLocalMessageIds: Set<string>;
  identifiedSubmissionIds: Set<string>;
  knownLocalMessageIds: Set<string>;
  onSubmissionIdentified?: (submissionId: string) => void;
  pendingLocalClaimMessages: string[];
}) {
  const localMessages = agent.messages.filter(
    (message) => message.role === 'user' && message.id.startsWith('local:'),
  );
  for (const message of localMessages) {
    if (knownLocalMessageIds.has(message.id)) continue;
    knownLocalMessageIds.add(message.id);
    const expectedIndex = pendingLocalClaimMessages.indexOf(
      flueMessageText(message),
    );
    if (expectedIndex >= 0) {
      claimedLocalMessageIds.add(message.id);
      pendingLocalClaimMessages.splice(expectedIndex, 1);
    }
  }
  for (const message of localMessages) {
    if (
      claimedLocalMessageIds.has(message.id) &&
      message.submissionId &&
      !identifiedSubmissionIds.has(message.submissionId)
    ) {
      identifiedSubmissionIds.add(message.submissionId);
      onSubmissionIdentified?.(message.submissionId);
    }
  }
  for (const failed of agent.failedSends) {
    claimedLocalMessageIds.delete(failed.id);
  }
}

function flueMessageText(
  message: UseFlueAgentResult['messages'][number],
): string {
  return message.parts
    .map((part) =>
      part.type === 'text' && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

function observeLocalSettlements({
  agent,
  identifiedSubmissionIds,
  observedSettlements,
  onSubmissionSettled,
}: {
  agent: UseFlueAgentResult;
  identifiedSubmissionIds: Set<string>;
  observedSettlements: Set<string>;
  onSubmissionSettled?: (
    submissionId: string,
    outcome: 'completed' | 'failed' | 'aborted',
  ) => void;
}) {
  for (const settlement of agent.settlements) {
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
  const [connectionAttempt, setConnectionAttempt] = useState(0);

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

  const agentId = prReviewerConversationId(review.id, review.headSha);
  return (
    <ReviewerConversation
      agentId={agentId}
      isLocked={isLocked}
      key={`${agentId}:${connectionAttempt}`}
      onDraftChanged={onDraftChanged}
      onReconnect={() => setConnectionAttempt((attempt) => attempt + 1)}
      tour={tour}
      tourClosed={tourClosed}
      activeTourStepId={activeTourStepId}
      onActivateTourStep={onActivateTourStep}
      onAskTourStep={onAskTourStep}
      onCloseTour={onCloseTour}
      onOpenTour={onOpenTour}
      onBackToTourFinding={onBackToTourFinding}
      onTourPublished={onTourPublished}
      onRequestDeliveryChange={onRequestDeliveryChange}
      onSubmissionIdentified={onSubmissionIdentified}
      onSubmissionSettled={onSubmissionSettled}
      onSendMessage={onSendMessage}
      request={request?.conversationId === agentId ? request : null}
    />
  );
}

function ReviewerConversation({
  agentId,
  isLocked,
  onDraftChanged,
  onReconnect,
  tour,
  tourClosed,
  activeTourStepId,
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
  request,
}: {
  agentId: string;
  isLocked: boolean;
  onDraftChanged?: () => void;
  onReconnect: () => void;
  tour: PrReviewTour | null;
  tourClosed: boolean;
  activeTourStepId: string | null;
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
  request: PrReviewReviewerRequest | null;
}) {
  const conversationClient = useMemo(
    () => createNeondeckConversationClient('pr-reviewer', agentId),
    [agentId],
  );
  const agent = useFlueAgent({ client: conversationClient });
  const inputId = useId();
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const observedDraftToolCalls = useRef(new Set<string>());
  const observedTourToolCalls = useRef(new Set<string>());
  const tourHistorySeeded = useRef(false);
  const pendingLocalClaimMessagesRef = useRef<string[]>([]);
  const knownLocalMessageIdsRef = useRef(new Set<string>());
  const claimedLocalMessageIdsRef = useRef(new Set<string>());
  const identifiedSubmissionIdsRef = useRef(new Set<string>());
  const observedSettlementsRef = useRef(new Set<string>());
  const messages = useMemo(
    () => chatMessagesForRender(agent.messages),
    [agent.messages],
  );
  const items = useMemo(() => sessionTimelineItems(messages, []), [messages]);
  const autoScroll = useChatAutoScroll(agentId);
  const connectionError = agent.error?.message ?? null;
  const busy =
    sending || request?.delivery === 'sending' || agent.status === 'connecting';
  const ready = agent.historyReady && !connectionError && !busy && !isLocked;
  const managed = Boolean(onSendMessage);

  const beginLocalSubmissionClaim = useCallback(
    (message: string) => {
      for (const message of agent.messages) {
        if (message.role === 'user' && message.id.startsWith('local:')) {
          knownLocalMessageIdsRef.current.add(message.id);
        }
      }
      pendingLocalClaimMessagesRef.current.push(message);
    },
    [agent.messages],
  );

  const sendMessage = useCallback(
    async (message: string) => {
      if (!message.trim() || !ready) return false;
      setSendError(null);
      setSending(true);
      try {
        await agent.sendMessage(message.trim());
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
    if (managed) return;
    let changed = false;
    for (const message of agent.messages) {
      for (const part of message.parts) {
        if (
          part.type !== 'dynamic-tool' ||
          part.state !== 'output-available' ||
          typeof part.toolName !== 'string' ||
          typeof part.toolCallId !== 'string'
        ) {
          continue;
        }
        if (
          isPrReviewerDraftToolName(part.toolName) &&
          !observedDraftToolCalls.current.has(part.toolCallId)
        ) {
          observedDraftToolCalls.current.add(part.toolCallId);
          if (draftMutationSucceeded(part.output)) changed = true;
        }
      }
    }
    if (changed) onDraftChanged?.();
  }, [agent.messages, managed, onDraftChanged]);

  useEffect(() => {
    if (managed) return;
    if (!request || request.delivery !== 'pending' || !ready) return;
    beginLocalSubmissionClaim(request.message);
    onRequestDeliveryChange?.(request.id, 'sending');
    void agent
      .sendMessage(request.message)
      .then(() => onRequestDeliveryChange?.(request.id, 'sent'))
      .catch((cause) => {
        onRequestDeliveryChange?.(
          request.id,
          'failed',
          cause instanceof Error ? cause.message : String(cause),
        );
      });
  }, [
    agent,
    beginLocalSubmissionClaim,
    managed,
    onRequestDeliveryChange,
    ready,
    request,
  ]);

  useEffect(() => {
    if (managed) return;
    const localMessages = agent.messages.filter(
      (message) => message.role === 'user' && message.id.startsWith('local:'),
    );
    for (const message of localMessages) {
      if (knownLocalMessageIdsRef.current.has(message.id)) continue;
      knownLocalMessageIdsRef.current.add(message.id);
      if (
        pendingLocalClaimMessagesRef.current.includes(
          flueMessageText(message),
        ) &&
        !claimedLocalMessageIdsRef.current.has(message.id)
      ) {
        claimedLocalMessageIdsRef.current.add(message.id);
        pendingLocalClaimMessagesRef.current.splice(
          pendingLocalClaimMessagesRef.current.indexOf(
            flueMessageText(message),
          ),
          1,
        );
      }
    }
    for (const message of localMessages) {
      if (
        claimedLocalMessageIdsRef.current.has(message.id) &&
        message.submissionId &&
        !identifiedSubmissionIdsRef.current.has(message.submissionId)
      ) {
        identifiedSubmissionIdsRef.current.add(message.submissionId);
        onSubmissionIdentified?.(message.submissionId);
      }
    }
    for (const failed of agent.failedSends) {
      claimedLocalMessageIdsRef.current.delete(failed.id);
    }
  }, [agent.failedSends, agent.messages, managed, onSubmissionIdentified]);

  useEffect(() => {
    if (managed) return;
    for (const settlement of agent.settlements) {
      if (
        observedSettlementsRef.current.has(settlement.submissionId) ||
        !identifiedSubmissionIdsRef.current.has(settlement.submissionId)
      ) {
        continue;
      }
      observedSettlementsRef.current.add(settlement.submissionId);
      onSubmissionSettled?.(settlement.submissionId, settlement.outcome);
    }
  }, [agent.settlements, managed, onSubmissionSettled]);

  useEffect(() => {
    if (managed) return;
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
  }, [agent.historyReady, agent.messages, managed, onTourPublished]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || !ready) return;
    setInput('');
    if (onSendMessage) {
      onSendMessage(message);
      return;
    }
    beginLocalSubmissionClaim(message);
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
        {!managed && request?.delivery === 'failed' ? (
          <div className="pr-reviewer-chat-error" role="alert">
            <p>Reviewer request failed</p>
            <span>{request.error}</span>
            <button
              onClick={() =>
                onRequestDeliveryChange?.(request.id, 'pending', null)
              }
              type="button"
            >
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
