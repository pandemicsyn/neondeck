import { readFileSync } from 'node:fs';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';
import { resolveBuildVersion } from './src/package-version.ts';

const buildVersion = resolveBuildVersion(
  new URL('./package.json', import.meta.url),
);

export default defineConfig({
  plugins: [
    flue(),
    {
      name: 'neondeck-loopback-server',
      apply: 'build',
      generateBundle(_options, bundle) {
        if (!bundle['app.mjs'] || !bundle['server.mjs']) {
          this.error('Expected Flue to emit app.mjs and server.mjs.');
        }
        // Flue's default launcher leaves the bind address unspecified.
        delete bundle['server.mjs'];
        delete bundle['server.mjs.map'];
        this.emitFile({
          type: 'asset',
          fileName: 'server.mjs',
          source: readFileSync(
            new URL('./src/server/production.mjs', import.meta.url),
          ),
        });
      },
    },
  ],
  define: {
    __NEONDECK_VERSION__: JSON.stringify(buildVersion),
  },
  server: {
    host: '127.0.0.1',
    port: 3583,
    watch: {
      ignored: [
        '**/.agents/**',
        '**/.changeset/**',
        '**/.codex/**',
        '**/.git/**',
        '**/.impeccable/**',
        '**/.playwright-mcp/**',
        '**/.plans/**',
        '**/.tmp-*',
        '**/.tmp-*/**',
        '**/.astro/**',
        '**/.flue-vite',
        '**/.flue-vite/**',
        '**/.flue-vite.wrangler.jsonc',
        '**/data/**',
        '**/design/**',
        '**/dist/**',
        '**/research-repos/**',
        '**/web/**',
        '**/docs/**',
      ],
    },
  },
});
