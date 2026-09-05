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
      name: 'neondeck-production-host',
      apply: 'build',
      buildStart() {
        this.emitFile({
          type: 'chunk',
          id: new URL('./src/server/production.ts', import.meta.url).pathname,
          fileName: 'neondeck-server.mjs',
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
