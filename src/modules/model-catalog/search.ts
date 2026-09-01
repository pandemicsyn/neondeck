import type { DiscoveredModel } from './model-discovery';

const modelIdCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

export function searchDiscoveredModels(
  models: readonly DiscoveredModel[],
  query: string,
): DiscoveredModel[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...models].sort(compareSearchMatches);

  return models
    .map((model) => ({
      model,
      relevance: matchRelevance(model, normalizedQuery),
    }))
    .filter(
      (match): match is { model: DiscoveredModel; relevance: number } =>
        match.relevance !== null,
    )
    .sort((left, right) => {
      if (left.relevance !== right.relevance) {
        return left.relevance - right.relevance;
      }
      return compareSearchMatches(left.model, right.model);
    })
    .map(({ model }) => model);
}

function matchRelevance(model: DiscoveredModel, query: string): number | null {
  const id = model.id.toLowerCase();
  const upstreamId = model.model.toLowerCase();
  const name = model.name.toLowerCase();
  const slug = upstreamId.split('/').at(-1) ?? upstreamId;
  const tokens = `${upstreamId} ${name}`.split(/[^a-z0-9]+/u);

  if (
    id === query ||
    upstreamId === query ||
    slug === query ||
    name === query
  ) {
    return 0;
  }
  if (slug.startsWith(query)) return 1;
  if (tokens.includes(query)) return 2;
  if (upstreamId.includes(query)) return 3;
  if (name.includes(query)) return 4;
  if (id.includes(query)) return 5;
  return null;
}

function compareSearchMatches(
  left: DiscoveredModel,
  right: DiscoveredModel,
): number {
  const leftCreatedAt = left.createdAt ?? Number.NEGATIVE_INFINITY;
  const rightCreatedAt = right.createdAt ?? Number.NEGATIVE_INFINITY;
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  return modelIdCollator.compare(left.id, right.id);
}
