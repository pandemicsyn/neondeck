import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody",
          GITHUB_WEBHOOK_SECRET_PREVIOUS: 'A Previous Secret, Rotated Out',
          WS_CLIENT_SECRET: 'test-client-secret-0123456789',
        },
      },
    }),
  ],
});
