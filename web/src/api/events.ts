import type {
  ConfigChangeEvent,
  ChatSessionCommandChangeEvent,
  ChatSessionChangeEvent,
  NotificationChangeEvent,
  PrReviewChangeEvent,
  GitHubQueueChangeEvent,
} from './types';
import { dashboardEventHub } from './event-hub';
import type { ReviewSourceRevisionEvent } from '../../../shared/review-refresh';
import type { ReviewTourChangeEvent } from '../../../shared/pr-review-tour';

export function openDashboardEventConnection(
  onOpen: () => void,
  onError?: (error?: Error | Event) => void,
) {
  return dashboardEventHub.subscribeConnection(onOpen, onError);
}

export function openGitHubQueueEventStream(
  onEvent: (event: GitHubQueueChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return dashboardEventHub.subscribe('github-queue-change', onEvent, onError);
}

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe('config-change', onEvent, onError, onOpen);
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'notification-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'chat-session-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openChatSessionCommandEventStream(
  onEvent: (event: ChatSessionCommandChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'chat-session-command-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openPrReviewEventStream(
  onEvent: (event: PrReviewChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe('review-change', onEvent, onError, onOpen);
}

export function openReviewSourceRevisionEventStream(
  onEvent: (event: ReviewSourceRevisionEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'review-source-revision',
    onEvent,
    onError,
    onOpen,
  );
}

export function openReviewTourEventStream(
  onEvent: (event: ReviewTourChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'review-tour-change',
    onEvent,
    onError,
    onOpen,
  );
}
