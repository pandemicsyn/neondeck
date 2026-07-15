import type { PrReviewRecord } from './types';

export type PrReviewEvent = {
  id: string;
  action: 'created' | 'changed';
  review: PrReviewRecord;
  changedAt: string;
};

type PrReviewEventListener = (event: PrReviewEvent) => void;

const listeners = new Set<PrReviewEventListener>();

export function publishPrReviewEvent(event: PrReviewEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      listeners.delete(listener);
      console.error('[neondeck] PR review event listener failed', error);
    }
  }
}

export function subscribePrReviewEvents(listener: PrReviewEventListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatPrReviewServerSentEvent(event: PrReviewEvent) {
  return [
    `id: ${event.id}:${event.changedAt}`,
    'event: review-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
