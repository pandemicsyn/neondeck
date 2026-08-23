import { flue } from '@flue/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { parseVersion } from './src/modules/updates/version';

const packageVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string;
const buildVersion =
  process.env.NEONDECK_RELEASE_VERSION?.trim() || packageVersion;
if (!parseVersion(buildVersion)) {
  throw new Error(
    `NEONDECK_RELEASE_VERSION must be a valid semantic version, got ${JSON.stringify(buildVersion)}.`,
  );
}

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
