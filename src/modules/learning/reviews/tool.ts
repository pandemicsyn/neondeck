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
import { compactJson } from './store';
import { runtimePaths } from '../../../runtime-home';

const completedEffectRecordSchema = v.looseObject({
  changed: v.optional(v.boolean()),
  id: v.optional(v.string()),
  candidateId: v.optional(v.string()),
  memoryId: v.optional(v.string()),
  skillId: v.optional(v.string()),
  candidate: v.optional(v.unknown()),
  memory: v.optional(v.unknown()),
});

export type CompletedEffectIdentifiers = {
  id?: string;
  candidateId?: string;
  memoryId?: string;
  skillId?: string;
};

type CompletedEffectRecord = v.InferOutput<typeof completedEffectRecordSchema>;

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
                  summarizeCompletedEffect(name, compactJson(effectResult)),
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
  result: import('@flue/runtime').JsonValue,
): CompletedLearningReviewEffect {
  const record = parseCompletedEffectRecord(result);
  const identifiers = readIdentifiers(record);
  const candidate =
    record?.candidate === undefined
      ? undefined
      : parseCompletedEffectRecord(compactJson(record.candidate));
  const memory =
    record?.memory === undefined
      ? undefined
      : parseCompletedEffectRecord(compactJson(record.memory));
  appendIdentifiers(identifiers, candidate);
  appendIdentifiers(identifiers, memory);
  return {
    name,
    changed: record?.changed === true,
    identifiers: Object.keys(identifiers).length > 0 ? identifiers : undefined,
  };
}

function readIdentifiers(record: CompletedEffectRecord | undefined) {
  const identifiers: CompletedEffectIdentifiers = {};
  appendIdentifiers(identifiers, record);
  return identifiers;
}

function appendIdentifiers(
  identifiers: CompletedEffectIdentifiers,
  record: CompletedEffectRecord | undefined,
) {
  if (!record) return;
  if (record.id) identifiers.id = record.id;
  if (record.candidateId) identifiers.candidateId = record.candidateId;
  if (record.memoryId) identifiers.memoryId = record.memoryId;
  if (record.skillId) identifiers.skillId = record.skillId;
}

function parseCompletedEffectRecord(value: import('@flue/runtime').JsonValue) {
  const parsed = v.safeParse(completedEffectRecordSchema, value);
  return parsed.success ? parsed.output : undefined;
}
