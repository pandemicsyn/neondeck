import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  compressHTML: false,
  output: 'static',
  site: 'https://neondeck.dev',
  integrations: [sitemap()],
});
