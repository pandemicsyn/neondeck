import { serve } from '@hono/node-server';
import type { RuntimePaths } from '../runtime-home';
import { createApp } from './create-app';

export const defaultServerPort = 3583;
export const defaultServerHost = '127.0.0.1';

export type StartServerOptions = {
  host?: string;
  port?: number | string;
  paths?: RuntimePaths;
  scheduler?: boolean;
  onReady?: (info: { host: string; port: number; url: string }) => void;
};

export async function startNeondeckServer(options: StartServerOptions = {}) {
  const host = options.host ?? defaultServerHost;
  const port = resolveServerPort(options.port);
  process.env.NEONDECK_PORT = String(port);
  process.env.PORT = String(port);

  const app = await createApp({
    paths: options.paths,
    scheduler: options.scheduler,
  });
  const url = `http://${host}:${port}`;

  const server = serve(
    {
      fetch: app.fetch,
      hostname: host,
      port,
    },
    () => options.onReady?.({ host, port, url }),
  );

  return { server, host, port, url };
}

export function resolveServerPort(value: number | string | undefined) {
  const raw = value ?? process.env.NEONDECK_PORT ?? process.env.PORT;
  if (raw === undefined || raw === '') return defaultServerPort;
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Port must be an integer between 1 and 65535, got ${JSON.stringify(raw)}.`,
    );
  }
  return port;
}
