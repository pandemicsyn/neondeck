import { defineConfig } from '@flue/cli/config';
import { defineConfig as defineViteConfig } from 'vite';

export default defineConfig({
  target: 'node',
});

export const vite = defineViteConfig({
  server: {
    watch: {
      ignored: [
        '**/.agents/**',
        '**/.changeset/**',
        '**/.codex/**',
        '**/.git/**',
        '**/.impeccable/**',
        '**/.playwright-mcp/**',
        '**/.plans/**',
        '**/.tmp-*/**',
        '**/.astro/**',
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
