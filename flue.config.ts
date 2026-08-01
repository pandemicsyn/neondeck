import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
  // Neondeck installs an exhaustive configuration-aware provider set in its
  // app entry. Do not preload Pi built-ins that can bypass disabled config.
  providers: [],
});
