import * as v from 'valibot';
import { receiptSchema } from './host-contract';
import { inspectLocalAttempt } from './local-host';

/** Only authenticated host observations may call this decoder. Missing legacy or
 * lost-supervisor endpoints leave usage unknown; controller timestamps are irrelevant. */
export function executionDurationFromReceipt(input: unknown): number | null {
  const receipt = v.parse(receiptSchema, input);
  if (receipt.state !== 'finished' || !receipt.noWriter) return null;
  const { startedAt, endedAt } = receipt;
  if (typeof startedAt === 'number' && typeof endedAt === 'number') {
    if (endedAt < startedAt || endedAt > receipt.at)
      throw new Error('Execution receipt endpoints are inconsistent');
    return v.parse(
      v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      endedAt - startedAt,
    );
  }
  if (startedAt === null && endedAt === null && receipt.group === null)
    return 0; // New host receipt proves that no provider was launched.
  return null;
}

/** Inspect verifies signed receipt identity and writer death before exposing usage. */
export async function localAttemptExecutionDuration(
  input: unknown,
): Promise<number | null> {
  const state = await inspectLocalAttempt(input);
  if (state.state !== 'finished') return null;
  try {
    return executionDurationFromReceipt(state.receipt);
  } catch {
    // A malformed or contradictory signed endpoint is unknown usage. The delivery
    // boundary keeps the full reservation and records an uncertainty intervention.
    return null;
  }
}
