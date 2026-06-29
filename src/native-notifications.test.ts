import { describe, expect, it } from 'vitest';
import { shouldDeliverNativeNotification } from './native-notifications';

describe('native notification delivery policy', () => {
  it('delivers only unresolved attention-worthy notifications by default', () => {
    expect(
      shouldDeliverNativeNotification(
        { level: 'attention', resolvedAt: null },
        {},
      ),
    ).toBe(true);
    expect(
      shouldDeliverNativeNotification(
        { level: 'urgent', resolvedAt: null },
        {},
      ),
    ).toBe(true);
    expect(
      shouldDeliverNativeNotification({ level: 'ready', resolvedAt: null }, {}),
    ).toBe(false);
    expect(
      shouldDeliverNativeNotification(
        { level: 'attention', resolvedAt: '2026-06-29T00:00:00.000Z' },
        {},
      ),
    ).toBe(false);
  });

  it('respects explicit disablement and keeps tests quiet unless forced', () => {
    expect(
      shouldDeliverNativeNotification(
        { level: 'attention', resolvedAt: null },
        { NEONDECK_NATIVE_NOTIFICATIONS: '0' },
      ),
    ).toBe(false);
    expect(
      shouldDeliverNativeNotification(
        { level: 'attention', resolvedAt: null },
        { NODE_ENV: 'test' },
      ),
    ).toBe(false);
    expect(
      shouldDeliverNativeNotification(
        { level: 'attention', resolvedAt: null },
        { NODE_ENV: 'test', NEONDECK_NATIVE_NOTIFICATIONS: '1' },
      ),
    ).toBe(true);
  });
});
