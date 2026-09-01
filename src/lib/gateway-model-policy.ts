export type GatewayProviderId = 'openrouter' | 'opencode';
export type GatewayModelRole = 'displayAssistant' | 'utility' | 'explore';

// Provider-role defaults remain intentionally disabled until the product
// decision is made with the user. The candidate chains still provide a small,
// known offline catalog without presenting one model as recommended.
export const gatewayModelDefaultsApproved = false;

type GatewayModelRecommendation = {
  model: string;
  name: string;
};

export const gatewayModelRecommendations: Record<
  GatewayProviderId,
  Record<GatewayModelRole, readonly GatewayModelRecommendation[]>
> = {
  openrouter: {
    displayAssistant: [
      { model: 'openai/gpt-5.6-terra', name: 'OpenAI GPT-5.6 Terra' },
      { model: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
      { model: 'openai/gpt-5.6-sol', name: 'OpenAI GPT-5.6 Sol' },
    ],
    utility: [
      { model: 'openai/gpt-5.6-luna', name: 'OpenAI GPT-5.6 Luna' },
      { model: 'google/gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    ],
    explore: [
      { model: 'openai/gpt-5.6-luna', name: 'OpenAI GPT-5.6 Luna' },
      { model: 'openai/gpt-5.6-terra', name: 'OpenAI GPT-5.6 Terra' },
    ],
  },
  opencode: {
    displayAssistant: [
      { model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
      { model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ],
    utility: [
      { model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { model: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
    ],
    explore: [
      { model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
    ],
  },
};

export function gatewayRecommendationModels(
  provider: GatewayProviderId,
  role: GatewayModelRole,
) {
  if (!gatewayModelDefaultsApproved) return [];
  return gatewayModelRecommendations[provider][role].map(
    (recommendation) => recommendation.model,
  );
}

export function defaultGatewayModel(
  provider: GatewayProviderId,
  role: GatewayModelRole = 'displayAssistant',
) {
  if (!gatewayModelDefaultsApproved) return undefined;
  const model = gatewayModelRecommendations[provider][role][0]?.model;
  return model ? `${provider}/${model}` : undefined;
}

export function suggestedGatewayModels(provider: GatewayProviderId) {
  const seen = new Set<string>();
  return (['displayAssistant', 'utility', 'explore'] as const)
    .flatMap((role) => gatewayModelRecommendations[provider][role])
    .filter(({ model }) => {
      if (seen.has(model)) return false;
      seen.add(model);
      return true;
    });
}
