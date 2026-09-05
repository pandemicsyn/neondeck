import { normalizeListenerEnv } from '../lib/server-address';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import type { Fetchable } from '@flue/runtime/routing';
export type HostedApplication = Fetchable & {
  pauseAdmissions(): void;
  stop(): Promise<void>;
};
export function listenerConfig(env: NodeJS.ProcessEnv = process.env) {
  return normalizeListenerEnv(env);
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
