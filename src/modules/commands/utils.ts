import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import type { MemoryScope } from '../memory';
import type { ThinkingLevel } from '../../runtime-home';

export const allThinkingLevels: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

export function supportedReasoningLevelsForModel(
  model: string,
): ThinkingLevel[] {
  const specifier = parseModelSpecifier(model);
  if (!specifier) return ['off'];

  if (specifier.provider === 'openai') {
    return isOpenAiReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  if (specifier.provider === 'anthropic') {
    return isAnthropicReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  if (specifier.provider === 'kilocode') {
    return isKilocodeReasoningModel(specifier.model)
      ? allThinkingLevels
      : ['off'];
  }

  return ['off'];
}

export function parseModelSpecifier(model: string) {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  return {
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
  };
}

export function isOpenAiReasoningModel(model: string) {
  return /^(gpt-5|o[1-9])(?:[.-]|$)/i.test(model);
}

export function isAnthropicReasoningModel(model: string) {
  return /^claude-(?:.*-4|3-7)(?:[.-]|$)/i.test(model);
}

export function isKilocodeReasoningModel(model: string) {
  const nested = parseModelSpecifier(model);
  if (nested?.provider === 'openai') {
    return isOpenAiReasoningModel(nested.model);
  }
  if (nested?.provider === 'anthropic') {
    return isAnthropicReasoningModel(nested.model);
  }

  return (
    /^kilo-auto(?:\/|$)/i.test(model) ||
    isOpenAiReasoningModel(model) ||
    isAnthropicReasoningModel(model) ||
    /(?:^|\/)(deepseek-r1|qwen.*thinking|.*reasoning.*)(?:[/:.-]|$)/i.test(
      model,
    )
  );
}

export function formatList(values: string[]) {
  if (values.length === 0) return 'no';
  if (values.length === 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`;
}

export function isMemoryScope(value: string | undefined): value is MemoryScope {
  return value === 'user' || value === 'local' || value === 'project';
}

export function isActiveMemoryScope(
  value: string | undefined,
): value is 'user' | 'local' | 'project' {
  return value === 'user' || value === 'local' || value === 'project';
}

export function parseMemoryValue(raw: string): JsonValue {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const stringArrayPropertySchema = v.looseObject({});

export function readStringArrayProperty<TValue>(
  value: TValue,
  key: string,
): string[] | undefined {
  const parsed = v.safeParse(stringArrayPropertySchema, value);
  if (!parsed.success) return undefined;
  const property = parsed.output[key];
  const array = v.safeParse(v.array(v.string()), property);
  return array.success ? array.output : undefined;
}

export function errorMessage<TError>(error: TError) {
  return error instanceof Error ? error.message : String(error);
}
