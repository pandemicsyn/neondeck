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
] as const;

export const defaultOpenAiCodexModel =
  `openai-codex/${openAiCodexModels[0].id}` as const;
