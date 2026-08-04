import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
  server: {
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
