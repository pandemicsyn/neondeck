import { describe, expect, it } from 'vitest';
import {
  nextOccurrence,
  validateAutomationTrigger,
} from './modules/scheduled-tasks';

describe('scheduled task triggers', () => {
  it('calculates five-field cron occurrences in the requested IANA timezone across DST', () => {
    const trigger = {
      kind: 'cron' as const,
      expression: '0 9 * * *',
      timezone: 'America/Chicago',
    };

    expect(validateAutomationTrigger(trigger)).toMatchObject({ ok: true });
    expect(nextOccurrence(trigger, new Date('2026-03-08T12:00:00.000Z'))).toBe(
      '2026-03-08T14:00:00.000Z',
    );
  });

  it('rejects a cron trigger with an invalid timezone', () => {
    expect(
      validateAutomationTrigger({
        kind: 'cron',
        expression: '0 9 * * *',
        timezone: 'Mars/Olympus',
      }),
    ).toMatchObject({ ok: false });
  });
});
