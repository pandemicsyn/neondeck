import * as v from 'valibot';

export type ParseInputResult<TInput, TResult> =
  { ok: true; input: TInput } | { ok: false; result: TResult };

export function parseInput<TInput, TResult, TRawInput>(
  schema: v.GenericSchema<unknown, TInput>,
  rawInput: TRawInput,
  invalidResult: (
    message: string,
    issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
  ) => TResult,
  messageForIssues: (
    issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
  ) => string = (issues) => v.summarize(issues),
): ParseInputResult<TInput, TResult> {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: invalidResult(messageForIssues(parsed.issues), parsed.issues),
  };
}

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const nullableStringColumnSchema = v.nullable(v.string());
export const isoDateStringSchema = v.pipe(v.string(), v.isoTimestamp());
export const nullableIsoDateStringColumnSchema =
  v.nullable(isoDateStringSchema);
