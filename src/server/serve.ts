import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function runBuiltNeondeckServer(
  options: Pick<StartServerOptions, 'port' | 'paths'> = {},
) {
  const port = resolveServerPort(options.port);
  const entry = resolvePackagedServerEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `Built Flue server entry was not found at ${entry}. Run npm run build:server or install a packaged Neondeck build before using neondeck serve.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: 'inherit',
      cwd: packageRootForServerEntry(entry),
      env: {
        ...process.env,
        ...(options.paths ? { NEONDECK_HOME: options.paths.home } : {}),
        NEONDECK_PORT: String(port),
        PORT: String(port),
      },
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

export function resolvePackagedServerEntry(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
) {
  if (env.NEONDECK_SERVER_ENTRY) return env.NEONDECK_SERVER_ENTRY;
  const candidates = [
    fileURLToPath(new URL('../../dist/server.mjs', import.meta.url)),
    join(cwd, 'dist', 'server.mjs'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function packageRootForServerEntry(entry: string) {
  return dirname(dirname(entry));
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
