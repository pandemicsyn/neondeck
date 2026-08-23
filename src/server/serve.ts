import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { RuntimePaths } from '../runtime-home';
import { manageChildProcess } from './child-process';

export const defaultServerPort = 3583;

export type RunBuiltServerOptions = {
  port?: number | string;
  paths?: RuntimePaths;
  verbose?: boolean;
};

export async function runBuiltNeondeckServer(
  options: RunBuiltServerOptions = {},
) {
  const port = resolveServerPort(options.port);
  const entry = resolvePackagedServerEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `Built Flue server entry was not found at ${entry}. Run npm run build:server or install a packaged Neondeck build before using neondeck serve.`,
    );
  }

  const child = spawn(process.execPath, [entry], {
    // Isolate terminal signals from the child so the controller forwards each
    // signal exactly once while the parent continues to own and await it.
    detached: true,
    windowsHide: true,
    stdio: ['inherit', 'pipe', 'inherit'],
    cwd: packageRootForServerEntry(entry),
    env: {
      ...process.env,
      ...(options.paths ? { NEONDECK_HOME: options.paths.home } : {}),
      ...(options.verbose ? { NEONDECK_LOG_LEVEL: 'debug' } : {}),
      NEONDECK_PORT: String(port),
      PORT: String(port),
    },
  });
  const controller = manageChildProcess(child);
  child.stdout
    .pipe(createServerOutputTransform(port, options.paths?.home))
    .pipe(process.stdout, { end: false });
  const result = await controller.exit;
  if (result.error) throw new Error(result.error);
  console.info(formatServerStop(result.code, result.signal));
  process.exitCode = result.signal
    ? serverSignalExitCode(result.signal)
    : (result.code ?? 0);
}

export function serverSignalExitCode(signal: NodeJS.Signals) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

export function formatServerStop(
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  if (signal) return `[neondeck] Server stopped signal=${signal}`;
  return `[neondeck] Server stopped code=${code ?? 0}`;
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
