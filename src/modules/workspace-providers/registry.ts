import type { WorkspaceProvider, WorkspaceProviderDescriptor } from './schemas';
import { WorkspaceProviderError } from './schemas';

export class WorkspaceProviderRegistry {
  readonly #providers = new Map<string, WorkspaceProvider>();

  register(provider: WorkspaceProvider) {
    const id = provider.descriptor.id;
    if (this.#providers.has(id)) {
      throw new WorkspaceProviderError(
        'invalid-config',
        `Workspace provider "${id}" is registered more than once.`,
        id,
      );
    }
    this.#providers.set(id, provider);
    return this;
  }

  get(id: string) {
    const provider = this.#providers.get(id);
    if (!provider) {
      throw new WorkspaceProviderError(
        'unknown-provider',
        `Workspace provider "${id}" is not configured.`,
        id,
      );
    }
    return provider;
  }

  list(): WorkspaceProviderDescriptor[] {
    return [...this.#providers.values()]
      .map((provider) => provider.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
