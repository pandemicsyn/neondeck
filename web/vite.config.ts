import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const serverPort = parsePort(process.env.NEONDECK_WEB_PORT, 5173);
const apiProxyTarget =
  process.env.NEONDECK_API_PROXY ?? 'http://127.0.0.1:3583';
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
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: serverPort,
    strictPort: true,
    proxy: {
      '/api': apiProxyTarget,
      '/reports': apiProxyTarget,
    },
  },
});

function parsePort(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `NEONDECK_WEB_PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}.`,
    );
  }

  return port;
}
