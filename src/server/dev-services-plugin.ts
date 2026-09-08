import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const entry = '\0neondeck:dev-server';
const bootstrap = 'neondeck:flue-bootstrap';

/** Flue 2.0.3 loads then stops applications on HMR. Its app export has no
 * disposal hook, so wrap the public loader/stop boundary, only in dev. */
export function devServicesPlugin(): Plugin {
  let bootstrapId: string | undefined;
  return {
    name: 'neondeck-dev-services',
    enforce: 'pre',
    apply: (_config, env) => env.command === 'serve' && !env.isPreview,
    async resolveId(id) {
      if (id === 'virtual:flue/server') {
        // A distinct importer avoids Vite reusing the in-progress resolution
        // of this wrapper while we ask the next plugin for the real bootstrap.
        const resolved = await this.resolve(id, import.meta.url, {
          skipSelf: true,
        });
        if (!resolved)
          throw new Error('Flue Node bootstrap could not be resolved.');
        bootstrapId = resolved.id;
        return entry;
      }
      if (id === bootstrap) return bootstrapId;
    },
    load(id) {
      if (id !== entry) return;
      const local = (path: string) =>
        JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
      return `
import { loadFlueNodeApplication as load } from '${bootstrap}';
import { devServiceOwner } from ${local('./dev-service-owner.ts')};
import { startManagedServices } from ${local('./managed-services.ts')};
import { runtimePaths } from ${local('../runtime-home/index.ts')};
export function loadFlueNodeApplication(options) {
  return devServiceOwner.load(() => load(options), async (app, ownCleanup) => {
    const paths = runtimePaths();
    return startManagedServices(paths, app, ownCleanup);
  });
}
`;
    },
  };
}
