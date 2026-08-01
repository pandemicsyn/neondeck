import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { RuntimePaths } from '../runtime-home';

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

  const { createApp } = await import('./create-app');
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
      stdio: ['inherit', 'pipe', 'inherit'],
      cwd: packageRootForServerEntry(entry),
      env: {
        ...process.env,
        ...(options.paths ? { NEONDECK_HOME: options.paths.home } : {}),
        NEONDECK_PORT: String(port),
        PORT: String(port),
      },
    });

    child.stdout
      .pipe(createServerOutputTransform(port, options.paths?.home))
      .pipe(process.stdout, { end: false });
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
) {
  if (env.NEONDECK_SERVER_ENTRY) return env.NEONDECK_SERVER_ENTRY;
  return fileURLToPath(new URL('../../dist/server.mjs', import.meta.url));
}

export function packageRootForServerEntry(entry: string) {
  return dirname(dirname(entry));
}

export function rewriteServerLogLine(
  line: string,
  port: number,
  runtimeHome?: string,
) {
  if (!/^\[flue\] Server listening on http:\/\/localhost:\d+\r?$/.test(line)) {
    return line;
  }

  return [
    '[neondeck] Server ready',
    `  dashboard  http://127.0.0.1:${port}/`,
    ...(runtimeHome ? [`  home       ${runtimeHome}`] : []),
    '  mode       foreground (Ctrl+C to stop)',
  ].join('\n');
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

function createServerOutputTransform(port: number, runtimeHome?: string) {
  let pending = '';

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        this.push(`${rewriteServerLogLine(line, port, runtimeHome)}\n`);
      }
      callback();
    },
    flush(callback) {
      if (pending) this.push(rewriteServerLogLine(pending, port, runtimeHome));
      callback();
    },
  });
}
