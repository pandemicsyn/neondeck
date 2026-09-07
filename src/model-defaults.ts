export const openAiCodexModels = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
  },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
] as const;

export const defaultOpenAiCodexModel =
  `openai-codex/${openAiCodexModels[0].id}` as const;
