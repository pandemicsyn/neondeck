import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_NEONDECK_VERSION': JSON.stringify(packageVersion),
  },
  build: {
    outDir: 'dist-perf',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./perf.html', import.meta.url)),
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4179,
    strictPort: true,
  },
});
