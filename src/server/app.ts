import { createApp } from './create-app';

export { createApp, resolveStaticRoot } from './create-app';

const app = await createApp({
  runtimeServices: process.env.NEONDECK_MANAGED_HOST !== '1',
  requestLogging: true,
});

process.once('SIGINT', () => {
  console.info('[neondeck] Server stopping signal=SIGINT');
});
process.once('SIGTERM', () => {
  console.info('[neondeck] Server stopping signal=SIGTERM');
});

export default app;
