export const registeredProviderIds = [
  'kilocode',
  'openai',
  'anthropic',
  'openai-codex',
  'openrouter',
  'opencode',
  'google-vertex',
] as const;

export type RegisteredProviderId = (typeof registeredProviderIds)[number];

export const reservedProviderIds = [
  ...registeredProviderIds,
  'openai-compatible',
] as const;

export function openAiCompatibleProviderIdIssue(value: string | undefined) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value ?? '')) {
    return 'Use lowercase letters, numbers, and hyphens.';
  }
  if ((reservedProviderIds as readonly string[]).includes(value ?? '')) {
    return 'That id is reserved by a built-in provider.';
  }
  return undefined;
}
