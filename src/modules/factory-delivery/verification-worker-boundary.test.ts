import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative } from 'node:path';
import { expect, it } from 'vitest';
import { build } from 'vite';

it('builds the detached verifier using only audited worker primitives and no model runtime', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const modules: string[] = [];
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'audit-verification-worker-boundary',
        generateBundle() {
          for (const id of this.getModuleIds()) modules.push(id);
        },
      },
    ],
    build: {
      ssr: fileURLToPath(new URL('./verification-worker.ts', import.meta.url)),
      write: false,
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: 'verification-worker.mjs',
          codeSplitting: false,
        },
      },
    },
  });
  // An explicit source allowlist also catches an unused barrel re-export that
  // happens to be tree-shaken today but eagerly loads policy/model code in tsx.
  const allowedSources = new Set([
    'src/modules/factory-delivery/verification-worker.ts',
    'src/modules/factory-delivery/verification-process.ts',
    'src/modules/factory-delivery/verification-supervisor.ts',
    'src/modules/repo-workflow-runtime/index.ts',
    'src/modules/execution/worker.ts',
    'src/modules/coding-runs/worker.ts',
    'src/modules/coding-runs/host-io.ts',
    'shared/repo-workflows.ts',
  ]);
  const allowedExternal = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    'valibot',
    'semver',
  ]);
  expect(modules.length).toBeGreaterThan(8);
  for (const module of modules) {
    if (!isAbsolute(module))
      expect(
        allowedExternal.has(module),
        `Unaudited worker dependency: ${module}`,
      ).toBe(true);
    else
      expect(
        allowedSources.has(relative(root, module)),
        `Unaudited worker source: ${module}`,
      ).toBe(true);
  }
  if (!('output' in output)) throw new Error('Expected one worker build');
  const chunks = output.output.filter((file) => file.type === 'chunk');
  expect(chunks).toHaveLength(1);
  expect(chunks[0].code).not.toMatch(/@flue\/|@ai-sdk\/|SKILL\.md/);
});
