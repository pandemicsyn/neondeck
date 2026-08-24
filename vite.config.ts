import { flue } from '@flue/vite';
import { defineConfig } from 'vite';
import { resolveBuildVersion } from './src/package-version.ts';

const buildVersion = resolveBuildVersion(
  new URL('./package.json', import.meta.url),
);

export default defineConfig({
  plugins: [flue()],
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
