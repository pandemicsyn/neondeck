import { describe, expect, it } from 'vitest';
import type { NotificationChangeEvent, NotificationRecord } from '../../api';
import { resolveToastConfig } from './policy';
import { initialToastState, toastReducer } from './reducer';
import { MAX_QUEUED_TOASTS } from './types';

const config = resolveToastConfig(undefined);

describe('toast reducer and policy', () => {
  it('ignores info and admits eligible live creation events', () => {
    const info = reduce(
      initialToastState,
      event('created', note({ level: 'info' })),
    );
    expect(info.items).toHaveLength(0);

    const ready = reduce(info, event('created', note({ id: 'ready' })));
    expect(ready.items).toHaveLength(1);
    expect(ready.items[0]?.expiresAt).toBe(7_000);
  });

  it('deduplicates creation and reconciles content in place', () => {
    const created = reduce(
      initialToastState,
      event('created', note({ id: 'same', title: 'First' })),
    );
    const duplicate = reduce(
      created,
      event(
        'created',
        note({ id: 'same', title: 'Duplicate', occurrenceCount: 1 }),
      ),
      2_000,
    );
    const reconciled = reduce(
      duplicate,
      event(
        'reconciled',
        note({ id: 'same', title: 'Updated', occurrenceCount: 3 }),
      ),
      3_000,
    );

    expect(reconciled.items).toHaveLength(1);
    expect(reconciled.items[0]?.notification.title).toBe('Updated');
    expect(reconciled.items[0]?.notification.occurrenceCount).toBe(3);
    expect(reconciled.items[0]?.admittedAt).toBe(1_000);
    expect(reconciled.items[0]?.expiresAt).toBe(9_000);
  });

  it('admits unread qualifying reconciliations and rejects read ones', () => {
    const admitted = reduce(
      initialToastState,
      event('reconciled', note({ id: 'missed' })),
    );
    const rejected = reduce(
      admitted,
      event(
        'reconciled',
        note({ id: 'read', readAt: '2026-07-11T00:00:00.000Z' }),
      ),
    );
    expect(rejected.items.map((item) => item.notification.id)).toEqual([
      'missed',
    ]);
  });

  it('makes escalated notifications persistent and removes read or resolved rows', () => {
    const created = reduce(
      initialToastState,
      event('created', note({ id: 'escalate' })),
    );
    const escalated = reduce(
      created,
      event(
        'reconciled',
        note({ id: 'escalate', level: 'urgent', occurrenceCount: 2 }),
      ),
    );
    expect(escalated.items[0]?.expiresAt).toBeNull();

    const read = reduce(
      escalated,
      event('read', note({ id: 'escalate', level: 'urgent' })),
    );
    expect(read.items).toHaveLength(0);

    const recreated = reduce(
      read,
      event('created', note({ id: 'resolve', level: 'attention' })),
    );
    const resolved = reduce(
      recreated,
      event('resolved', note({ id: 'resolve', level: 'attention' })),
    );
    expect(resolved.items).toHaveLength(0);
  });

  it('removes a visible toast when reconciliation drops below policy', () => {
    const created = reduce(
      initialToastState,
      event('created', note({ id: 'deescalate', level: 'attention' })),
    );
    const deescalated = reduce(
      created,
      event(
        'reconciled',
        note({ id: 'deescalate', level: 'info', occurrenceCount: 2 }),
      ),
    );
    expect(deescalated.items).toHaveLength(0);
  });

  it('supports local timeout and acknowledgement removal without durable semantics', () => {
    const created = reduce(
      initialToastState,
      event('created', note({ id: 'local' })),
    );
    const removed = toastReducer(created, { type: 'remove', id: 'local' });
    expect(removed.items).toHaveLength(0);
    expect(created.items[0]?.notification.readAt).toBeNull();
  });

  it('bounds producer bursts and retains the newest queued notifications', () => {
    let state = initialToastState;
    for (let index = 0; index < MAX_QUEUED_TOASTS + 4; index += 1) {
      state = reduce(
        state,
        event('created', note({ id: `note-${index}` })),
        index,
      );
    }
    expect(state.items).toHaveLength(MAX_QUEUED_TOASTS);
    expect(state.items[0]?.notification.id).toBe('note-4');
  });

  it('does not evict persistent urgent work during a ready-event burst', () => {
    let state = reduce(
      initialToastState,
      event('created', note({ id: 'urgent', level: 'urgent' })),
    );
    for (let index = 0; index < MAX_QUEUED_TOASTS + 4; index += 1) {
      state = reduce(
        state,
        event('created', note({ id: `ready-${index}` })),
        index,
      );
    }
    expect(state.items).toHaveLength(MAX_QUEUED_TOASTS);
    expect(state.items.some((item) => item.notification.id === 'urgent')).toBe(
      true,
    );
  });

  it('clamps dashboard policy values', () => {
    expect(
      resolveToastConfig({
        enabled: true,
        minimumLevel: 'attention',
        readyDurationMs: 20,
        maxVisible: 99,
      }),
    ).toEqual({
      enabled: true,
      minimumLevel: 'attention',
      readyDurationMs: 1_000,
      maxVisible: 3,
    });
  });
});

function reduce(
  state: typeof initialToastState,
  notificationEvent: NotificationChangeEvent,
  now = 1_000,
) {
  return toastReducer(state, {
    type: 'notification-event',
    event: notificationEvent,
    config,
    now,
  });
}

function event(
  action: NotificationChangeEvent['action'],
  notification: NotificationRecord,
): NotificationChangeEvent {
  return {
    id: notification.id,
    action,
    notification,
    changedAt: notification.updatedAt,
  };
}

function note(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'note',
    level: 'ready',
    title: 'Work ready',
    message: 'A prepared change is ready to inspect.',
    source: 'autopilot',
    sourceId: 'prepared-diff:one',
    data: { preparedDiffId: 'diff-1' },
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
