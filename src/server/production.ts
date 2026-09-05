import { privateServerUrl } from '../lib/server-address';
import { createGitHubIngress } from './github-ingress';
import { listenerConfig, startNeondeckListeners } from './listeners';
import { startManagedServices } from './managed-services';
import { getMcpRegistry } from '../domains/mcp';
import { runtimePaths } from '../runtime-home';
import { loadNeondeckEnv } from '../modules/runtime/env';
const paths = runtimePaths();
loadNeondeckEnv(paths, { includeDevFallback: false });
const config = listenerConfig();
process.env.NEONDECK_MANAGED_HOST = '1';
const { loadFlueNodeApplication } = await import('virtual:flue/server');
const application = await loadFlueNodeApplication();
let stopSources = () => getMcpRegistry(paths).stop();
const lifecycle = await startNeondeckListeners(
  application,
  createGitHubIngress(paths),
  config,
  () => stopSources(),
);
stopSources = startManagedServices(paths, application);
console.info(
  `[flue] Server listening on ${privateServerUrl(config.privatePort)}`,
);
if (config.publicPort)
  console.info(
    '[neondeck] Separate webhook listener ready; private app remains loopback-only.',
  );
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  try {
    await lifecycle.stop();
    process.exit(code);
  } catch {
    console.error('[neondeck] Shutdown failed.');
    process.exit(1);
  }
}
process.once('SIGINT', () => void stop(130));
process.once('SIGTERM', () => void stop(143));
process.once('disconnect', () => void stop(0));
