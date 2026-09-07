/* eslint-disable no-control-regex -- Reject terminal control characters at input boundaries. */
import { log, spinner } from '@clack/prompts';
import * as v from 'valibot';
import { defaultOpenAiCodexModel } from '../model-defaults';
import {
  discoverModels,
  searchDiscoveredModels,
  suggestedModels,
  type DiscoveredModel,
} from '../modules/model-catalog';
import { promptSelect, promptText } from './prompts';

export const defaultKiloCodingModel = 'kilo/kilo-auto/frontier';
const modelId = v.pipe(
  v.string(),
  v.maxLength(261),
  v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
);
const catalogEntry = v.object({
  provider: v.literal('kilocode'),
  model: modelId,
  name: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(256),
    v.regex(/^[^\x00-\x1f\x7f]*$/u),
  ),
});
export function validateCodingModel(id: string, model: string) {
  if (!v.safeParse(modelId, model).success)
    return 'Enter a model ID using letters, digits, dots, colons, slashes or hyphens.';
  if (
    id === 'kilo' &&
    !/^kilo\/[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(model)
  )
    return 'Use the Kilo CLI prefix: kilo/provider/model.';
  if (id === 'codex' && model.includes('/'))
    return 'Use a Codex model ID without a provider prefix.';
  if (id === 'opencode' && !model.includes('/'))
    return 'Use a provider/model ID.';
  return undefined;
}
function choice(model: string, name: string): DiscoveredModel {
  return {
    id: `kilocode/${model}`,
    provider: 'kilocode',
    model,
    name,
    api: null,
    contextLength: null,
    reasoning: true,
    isFree: null,
    createdAt: null,
    recommendedIndex: null,
    source: 'suggested',
  };
}
export async function codingModels(
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<{ models: DiscoveredModel[]; warning?: string }> {
  if (id === 'codex') return { models: suggestedModels('openai-codex') };
  if (id !== 'kilo') return { models: [] };
  const fallback = [choice('kilo-auto/frontier', 'Kilo Auto Frontier')];
  if (!env.KILOCODE_API_KEY?.trim())
    return {
      models: fallback,
      warning:
        'No KILOCODE_API_KEY configured. Using Kilo Auto Frontier; authentication is still required.',
    };
  try {
    const result = await discoverModels({
      provider: 'kilocode',
      apiKey: env.KILOCODE_API_KEY,
      organizationId: env.KILOCODE_ORGANIZATION_ID,
    });
    const models = new Map(fallback.map((model) => [model.model, model]));
    for (const row of result.models) {
      const parsed = v.safeParse(catalogEntry, row);
      if (!parsed.success) continue;
      const { model, name } = parsed.output;
      if (
        model.startsWith('kilocode/') ||
        model.startsWith('kilo/') ||
        validateCodingModel('kilo', `kilo/${model}`)
      )
        continue;
      models.set(model, choice(model, name));
    }
    return {
      models: [...models.values()],
      ...(!result.ok || result.diagnostics.stale
        ? {
            warning:
              'Kilo catalog unavailable. Suggested models are available; authentication remains unverified.',
          }
        : {}),
    };
  } catch {
    return {
      models: fallback,
      warning:
        'Kilo catalog unavailable. Using Kilo Auto Frontier; authentication remains unverified.',
    };
  }
}
function cliModel(id: string, model: DiscoveredModel) {
  return id === 'kilo' ? `kilo/${model.model}` : model.model;
}
export async function pickCodingModel(
  id: string,
  current: string | null,
  env: NodeJS.ProcessEnv,
) {
  const activity =
    id === 'kilo' && env.KILOCODE_API_KEY?.trim() ? spinner() : null;
  activity?.start('Discovering Kilo models');
  let catalog: Awaited<ReturnType<typeof codingModels>>;
  try {
    catalog = await codingModels(id, env);
  } finally {
    activity?.stop('Kilo model discovery finished');
  }
  if (catalog.warning) log.info(catalog.warning);
  const defaultModel =
    current ??
    (id === 'codex'
      ? defaultOpenAiCodexModel.replace('openai-codex/', '')
      : id === 'kilo'
        ? defaultKiloCodingModel
        : '');
  let query = '';
  let page = 0;
  while (true) {
    const matches = searchDiscoveredModels(catalog.models, query);
    const visible = matches.slice(page * 10, (page + 1) * 10);
    const selected = await promptSelect({
      message: `Coding model${query ? ` matching "${query}"` : ''} (${matches.length} catalog choices)`,
      initialValue: defaultModel || ':manual',
      options: [
        ...(defaultModel
          ? [
              {
                value: defaultModel,
                label: `${defaultModel} (${current ? 'current' : 'default'})`,
              },
            ]
          : []),
        ...visible
          .filter((model) => cliModel(id, model) !== defaultModel)
          .map((model) => ({
            value: cliModel(id, model),
            label: model.name,
            hint: cliModel(id, model),
          })),
        { value: ':search', label: 'Search models' },
        ...(page > 0 ? [{ value: ':previous', label: 'Previous page' }] : []),
        ...((page + 1) * 10 < matches.length
          ? [{ value: ':next', label: 'Next page' }]
          : []),
        { value: ':manual', label: 'Enter a model ID manually (advanced)' },
      ],
    });
    if (selected === ':search') {
      query = await promptText({
        message: 'Search model name or ID (blank shows all)',
        initialValue: query,
        validate: (value) =>
          (value ?? '').length > 256 || /[\x00-\x1f\x7f]/u.test(value ?? '')
            ? 'Enter up to 256 printable characters.'
            : undefined,
      });
      page = 0;
    } else if (selected === ':previous') page = Math.max(0, page - 1);
    else if (selected === ':next') page++;
    else {
      const model =
        selected === ':manual'
          ? await promptText({
              message:
                id === 'kilo'
                  ? 'Kilo CLI model ID (kilo/provider/model)'
                  : 'Coding model ID',
              initialValue: defaultModel,
              validate: (value) => validateCodingModel(id, value ?? ''),
            })
          : selected;
      const error = validateCodingModel(id, model);
      if (error) throw new Error(error);
      return model;
    }
  }
}
