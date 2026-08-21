import { failedAction } from '../../lib/action-result';
import { parseInput as parseSharedInput } from '../../lib/valibot';
import { asJsonValue } from '../../lib/action-result';
import type {
  PrWatch,
  RefWatch,
  WatchActionResult,
  WatchOutcome,
} from './schemas';
import * as v from 'valibot';

const watchExternalValueSchema = v.unknown();
export type WatchExternalValue = v.InferInput<typeof watchExternalValueSchema>;
const errorSchema = v.instance(Error);

export function parseActionInput<T>(
  schema: v.GenericSchema<WatchExternalValue, T>,
  input: WatchExternalValue,
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
    watch?: PrWatch | RefWatch | WatchExternalValue;
    watches?: Array<PrWatch | RefWatch | WatchExternalValue>;
  } = {},
): WatchActionResult {
  const result: WatchActionResult = {
    ok: true,
    action,
    changed,
    message,
  };
  if (outcome) result.outcome = outcome;
  if (data.watch !== undefined) result.watch = asJsonValue(data.watch);
  if (data.watches) result.watches = data.watches.map(asJsonValue);
  return result;
}

export const failResult = failedAction<
  Pick<WatchActionResult, 'errors' | 'requires'>
>;

export function errorMessage(error: WatchExternalValue) {
  const parsed = v.safeParse(errorSchema, error);
  return parsed.success ? parsed.output.message : String(error);
}
