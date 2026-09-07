import * as v from 'valibot';
import { codingAdapterCapabilitiesSchema } from '../../../../shared/coding-adapters.ts';
import { codexAdapter } from './codex.ts';
import { opencodeAdapter } from './opencode.ts';
import type { CodingAdapter } from './contract.ts';
// Deliberately compiled in; user configuration cannot import executable plugins.
const adapters: readonly CodingAdapter[] = [codexAdapter, opencodeAdapter];
export function createCodingAdapterRegistry(entries: readonly CodingAdapter[]) {
  const registry = new Map<string, CodingAdapter>();
  for (const adapter of entries) {
    if (registry.has(adapter.id)) throw new Error('Duplicate coding adapter');
    v.parse(codingAdapterCapabilitiesSchema, adapter.capabilities);
    registry.set(adapter.id, adapter);
  }
  return {
    get(id: string, version = 1): CodingAdapter {
      const adapter = registry.get(id);
      if (!adapter || adapter.contractVersion !== version)
        throw new Error('Unsupported coding adapter contract');
      return adapter;
    },
    list: () =>
      entries.map(
        ({
          id,
          contractVersion,
          label,
          capabilities,
          supportedPlatforms,
          supportedVersion,
          credentialKinds,
        }) => ({
          id,
          contractVersion,
          label,
          capabilities,
          supportedPlatforms,
          supportedVersion,
          credentialKinds,
        }),
      ),
  };
}
const registry = createCodingAdapterRegistry(adapters);
export const getCodingAdapter = registry.get;
export const listCodingAdapters = registry.list;
