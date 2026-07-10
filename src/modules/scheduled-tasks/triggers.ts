import { Cron } from 'croner';
import * as v from 'valibot';
import { automationTriggerSchema, type AutomationTrigger } from './schemas';

export function validateAutomationTrigger(input: unknown) {
  const parsed = v.safeParse(automationTriggerSchema, input);
  if (!parsed.success) {
    return { ok: false as const, message: v.summarize(parsed.issues) };
  }
  const trigger = parsed.output;
  if (trigger.kind === 'once') {
    if (!isIsoDate(trigger.at)) {
      return {
        ok: false as const,
        message: 'One-shot scheduled tasks require an ISO timestamp.',
      };
    }
  }
  if (trigger.kind === 'cron') {
    if (!isIanaTimezone(trigger.timezone)) {
      return {
        ok: false as const,
        message: `"${trigger.timezone}" is not a supported IANA timezone.`,
      };
    }
    try {
      new Cron(trigger.expression, {
        timezone: trigger.timezone,
        paused: true,
      });
    } catch (error) {
      return {
        ok: false as const,
        message: `Invalid cron expression: ${errorMessage(error)}.`,
      };
    }
  }
  return { ok: true as const, trigger };
}

export function nextOccurrence(
  trigger: AutomationTrigger,
  from = new Date(),
): string | null {
  if (trigger.kind === 'interval') {
    return new Date(
      from.getTime() + trigger.everySeconds * 1_000,
    ).toISOString();
  }
  if (trigger.kind === 'once') {
    const at = new Date(trigger.at);
    return at.getTime() > from.getTime() ? at.toISOString() : null;
  }
  return (
    new Cron(trigger.expression, {
      timezone: trigger.timezone,
      paused: true,
    })
      .nextRun(from)
      ?.toISOString() ?? null
  );
}

export function describeTrigger(trigger: AutomationTrigger) {
  if (trigger.kind === 'interval') {
    return `every ${trigger.everySeconds} seconds`;
  }
  if (trigger.kind === 'once') return `once at ${trigger.at}`;
  return `${trigger.expression} (${trigger.timezone})`;
}

function isIsoDate(value: string) {
  return !Number.isNaN(Date.parse(value));
}

function isIanaTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
