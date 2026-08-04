import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  completeLearningReviewFromModelOutput,
  failPreparedLearningReview,
  type CompletedLearningReviewEffect,
} from './complete';
import {
  learningReviewerOutputSchema,
  learningReviewOutputSchema,
  type PreparedLearningReview,
} from './schemas';
import { runtimePaths } from '../../../runtime-home';

export function createSubmitLearningReviewTool(
  prepared: PreparedLearningReview,
) {
  let execution:
    | Promise<{
        output: v.InferOutput<typeof learningReviewOutputSchema>;
        terminate: true;
      }>
    | undefined;
  return defineTool({
    name: 'neondeck_submit_learning_review',
    description:
      'Submit the structured result of the bounded learning review and apply Neondeck learning policy. Call exactly once after reviewing the evidence in the current signal.',
    input: learningReviewerOutputSchema,
    output: learningReviewOutputSchema,
    durable: true,
    async run({ data, log, step }) {
      execution ??= (async () => {
        const completedEffects: CompletedLearningReviewEffect[] = [];
        let uncertainEffect: string | undefined;
        try {
          const result = await completeLearningReviewFromModelOutput(
            prepared,
            data,
            runtimePaths(),
            {
              runEffect: async (name, effect) => {
                uncertainEffect = name;
                const effectResult = await step.do(name, effect);
                completedEffects.push(
                  summarizeCompletedEffect(name, effectResult),
                );
                uncertainEffect = undefined;
                return effectResult;
              },
            },
          );
          if (!result.ok) {
            log.error('Learning review produced an invalid result', {
              reviewId: prepared.reviewId,
              message: result.message,
            });
          }
          return {
            output: v.parse(learningReviewOutputSchema, result),
            terminate: true,
          } as const;
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          const result = await step.do('fail-review', () =>
            failPreparedLearningReview(prepared, failure, runtimePaths(), {
              completedEffects,
              uncertainEffect,
            }),
          );
          log.error('Learning review failed', {
            reviewId: prepared.reviewId,
            message: failure.message,
          });
          return {
            output: v.parse(learningReviewOutputSchema, result),
            terminate: true,
          } as const;
        }
      })();
      return execution;
    },
  });
}

function summarizeCompletedEffect(
  name: string,
  result: unknown,
): CompletedLearningReviewEffect {
  const record = asRecord(result);
  const identifiers = {
    ...readIdentifiers(record),
    ...readIdentifiers(asRecord(record?.candidate)),
    ...readIdentifiers(asRecord(record?.memory)),
  };
  return {
    name,
    changed: record?.changed === true,
    ...(Object.keys(identifiers).length > 0 ? { identifiers } : {}),
  };
}

function readIdentifiers(
  record: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!record) return {};
  const identifiers: Record<string, string> = {};
  for (const key of ['id', 'candidateId', 'memoryId', 'skillId']) {
    const value = record[key];
    if (typeof value === 'string') identifiers[key] = value;
  }
  return identifiers;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
