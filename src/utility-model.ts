import type { RuntimePaths } from './runtime-home';
import { readAgentModelSelectionSync } from './agent-config';

export type UtilityTitleSuggestionInput = {
  reason?: string;
  label?: string;
};

export type UtilityTitleSuggestion = {
  title: string;
  model: string;
  thinkingLevel: string;
  fallback: boolean;
  invokedModel: boolean;
};

export function suggestUtilitySessionTitle(
  input: UtilityTitleSuggestionInput,
  paths?: RuntimePaths,
): UtilityTitleSuggestion {
  const models = paths
    ? readAgentModelSelectionSync(paths)
    : readAgentModelSelectionSync();
  const seed = input.label ?? input.reason ?? 'Fresh';

  return {
    title: compactTitle(seed),
    model: models.utility,
    thinkingLevel: models.utilityThinkingLevel,
    fallback: !models.utilityConfigured,
    invokedModel: false,
  };
}

function compactTitle(value: string) {
  const title = value
    .replace(/[-_:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');

  if (!title) return 'Fresh';
  return title.length > 48 ? `${title.slice(0, 45).trimEnd()}...` : title;
}
