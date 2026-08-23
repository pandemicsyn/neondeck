import { flue } from '@flue/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const packageVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string;

export default defineConfig({
  plugins: [flue()],
  define: {
    __NEONDECK_VERSION__: JSON.stringify(packageVersion),
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
