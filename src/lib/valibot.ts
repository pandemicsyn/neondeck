import * as v from 'valibot';

export type ParseInputResult<TInput, TResult> =
  { ok: true; input: TInput } | { ok: false; result: TResult };

export function parseInput<TInput, TResult>(
  schema: v.GenericSchema<unknown, TInput>,
  rawInput: unknown,
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
  const issues = parsed.issues as [
    v.BaseIssue<unknown>,
    ...v.BaseIssue<unknown>[],
  ];
  return {
    ok: false,
    result: invalidResult(messageForIssues(issues), issues),
  };
}

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const nullableStringColumnSchema = v.nullable(v.string());
export const isoDateStringSchema = v.pipe(v.string(), v.isoTimestamp());
export const nullableIsoDateStringColumnSchema =
  v.nullable(isoDateStringSchema);
