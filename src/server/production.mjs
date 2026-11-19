import { startFlueNodeServer } from './app.mjs';

const configuredPort = process.env.NEONDECK_PORT ?? process.env.PORT;
const server = await startFlueNodeServer({
  hostname: '127.0.0.1',
  port: configuredPort ? Number(configuredPort) : 3583,
});

let stopping = false;
for (const [event, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['disconnect', 0],
]) {
  process.once(event, async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), 30_000).unref();
    try {
      await server.stop();
      process.exit(code);
    } catch (error) {
      console.error('[neondeck] Shutdown failed.', error);
      process.exit(1);
    }
  });
}
