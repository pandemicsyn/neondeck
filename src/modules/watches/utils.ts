import { failedAction } from '../../lib/action-result';
import { parseInput as parseSharedInput } from '../../lib/valibot';
import { asJsonValue } from '../../lib/action-result';
import type { PrWatch, RefWatch, WatchActionResult, WatchOutcome } from './schemas';
import type * as v from 'valibot';

export function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
) {
  return parseSharedInput(schema, input, (message) =>
    failResult(action, 'Invalid action input.', {
      errors: [message],
    }),
  );
}

export function okResult(
  action: string,
  changed: boolean,
  outcome: WatchOutcome | undefined,
  message: string,
  data: {
    watch?: PrWatch | RefWatch;
    watches?: Array<PrWatch | RefWatch>;
  } = {},
): WatchActionResult {
  return {
    ok: true,
    action,
    changed,
    ...(outcome ? { outcome } : {}),
    message,
    ...(data.watch ? { watch: asJsonValue(data.watch) } : {}),
    ...(data.watches ? { watches: data.watches.map(asJsonValue) } : {}),
  };
}

export const failResult = failedAction<Pick<WatchActionResult, 'errors' | 'requires'>>;

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
