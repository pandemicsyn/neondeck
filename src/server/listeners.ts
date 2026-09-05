import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { Fetchable } from '@flue/runtime/routing';
export type HostedApplication = Fetchable & {
  pauseAdmissions(): void;
  stop(): Promise<void>;
};
export function listenerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsePort = (raw: string | undefined, fallback: number) => {
    const number = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > 65535)
      throw new Error('Listener port must be between 1 and 65535.');
    return number;
  };
  const privateHost = env.NEONDECK_PRIVATE_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(privateHost))
    throw new Error(
      'Private listener must bind to loopback. Use an authenticated tunnel or SSH forwarding.',
    );
  const privatePort = parsePort(env.NEONDECK_PORT ?? env.PORT, 3583);
  const publicPort = env.NEONDECK_INGRESS_PORT
    ? parsePort(env.NEONDECK_INGRESS_PORT, 0)
    : null;
  if (publicPort === privatePort)
    throw new Error('Public and private listener ports must differ.');
  return {
    privateHost,
    privatePort,
    publicHost: env.NEONDECK_INGRESS_HOST ?? '127.0.0.1',
    publicPort,
  };
}
async function bind(app: Fetchable, host: string, port: number) {
  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = serve(
      {
        fetch: app.fetch.bind(app),
        hostname: host,
        port,
        serverOptions: { requestTimeout: 10000, headersTimeout: 10000 },
      },
      () => resolve(),
    ) as Server;
    server.once('error', reject);
  });
  return server!;
}
async function close(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
export async function startNeondeckListeners(
  application: HostedApplication,
  ingress: Fetchable,
  config = listenerConfig(),
  stopServices: () => Promise<void> = async () => {},
) {
  const servers: Server[] = [];
  try {
    servers.push(
      await bind(application, config.privateHost, config.privatePort),
    );
    if (config.publicPort)
      servers.push(await bind(ingress, config.publicHost, config.publicPort));
  } catch (error) {
    await Promise.allSettled(servers.map(close));
    await Promise.allSettled([stopServices(), application.stop()]);
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    stop() {
      return (stopping ??= (async () => {
        application.pauseAdmissions();
        const closed = Promise.allSettled(servers.map(close));
        const failures: unknown[] = [];
        try {
          await stopServices();
        } catch (error) {
          failures.push(error);
        }
        try {
          await application.stop();
        } catch (error) {
          failures.push(error);
        }
        await closed;
        if (failures.length)
          throw new AggregateError(failures, 'Neondeck shutdown failed.');
      })());
    },
  };
}
