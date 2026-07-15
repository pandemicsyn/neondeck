import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPrReviewEventStream } from './events';
import type { PrReviewChangeEvent } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe('dashboard event streams', () => {
  it('shares one EventSource across subscribers until the last one leaves', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const first: PrReviewChangeEvent[] = [];
    const second: PrReviewChangeEvent[] = [];
    const closeFirst = openPrReviewEventStream((event) => first.push(event));
    const closeSecond = openPrReviewEventStream((event) => second.push(event));

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    source.emit('review-change', reviewEvent());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    closeFirst();
    expect(source.closed).toBe(false);
    closeSecond();
    expect(source.closed).toBe(true);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener) {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(name: string, event: PrReviewChangeEvent) {
    const message = new MessageEvent(name, { data: JSON.stringify(event) });
    for (const listener of this.listeners.get(name) ?? []) listener(message);
  }
}

function reviewEvent(): PrReviewChangeEvent {
  return {
    id: 'event-1',
    action: 'changed',
    changedAt: '2026-07-15T00:00:00.000Z',
    review: {
      id: 'review-1',
      ref: 'owner/repo#1',
      repoFullName: 'owner/repo',
      prNumber: 1,
      title: 'Review me',
      author: 'author',
      prUrl: 'https://github.com/owner/repo/pull/1',
      status: 'ready',
      runId: 'run-1',
      headSha: 'head-1',
      origin: 'panel',
      reviewUrl: '/review?repo=owner%2Frepo&number=1',
      reportIds: ['report-1'],
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
      reportOnlyFindings: [],
      trustBoundary: 'Local drafts only.',
      verdict: null,
      previousVerdict: null,
      githubReviewUrl: null,
      failureMessage: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
      readyAt: '2026-07-15T00:00:00.000Z',
      submittedAt: null,
      failedAt: null,
    },
  };
}
