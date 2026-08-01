import { setProvider } from '@flue/runtime';
import type { ModelAuth } from '@earendil-works/pi-ai';
import { loadNeondeckEnv } from '../runtime';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  effectiveModelSpecifiers,
  openAiCodexProviderFromModelAuth,
  providerRuntimeRegistrations,
  readProviderConfigSync,
  resolveOpenAiCodexProviderStatus,
} from './providers';
import {
  resolveOpenAiCodexModelAuth,
  startOpenAiCodexTokenRefresh,
} from './openai-codex-auth';

/** Install the exact provider set declared by Neondeck runtime configuration. */
export async function installNeondeckProviders(
  paths: RuntimePaths = runtimePaths(),
) {
  process.env.NEONDECK_HOME = paths.home;
  loadNeondeckEnv(paths);
  const appConfig = readProviderConfigSync(paths);
  const readEffectiveModelSpecifiers = () =>
    effectiveModelSpecifiers(readProviderConfigSync(paths), process.env);

  for (const registration of providerRuntimeRegistrations(
    process.env,
    appConfig,
    readEffectiveModelSpecifiers,
  )) {
    setProvider(registration.provider);
  }

  // Always shadow Pi's built-in provider. A disabled Neondeck subscription
  // provider must stay unavailable even in `flue run`, which preloads all
  // built-ins before evaluating the requested agent module.
  let auth: ModelAuth | undefined;
  if (resolveOpenAiCodexProviderStatus(appConfig).enabled) {
    try {
      auth = await resolveOpenAiCodexModelAuthForStartup(paths);
    } catch (error) {
      console.warn(
        '[neondeck] ChatGPT subscription authentication needs attention',
        error,
      );
    }
  }
  setProvider(openAiCodexProviderFromModelAuth(auth));

  if (resolveOpenAiCodexProviderStatus(appConfig).enabled) {
    startOpenAiCodexTokenRefresh(paths, (refreshedAuth) => {
      setProvider(openAiCodexProviderFromModelAuth(refreshedAuth));
    });
  }

  return appConfig;
}

export async function resolveOpenAiCodexModelAuthForStartup(
  paths: RuntimePaths,
  timeoutMs = 5_000,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolveOpenAiCodexModelAuth(paths),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `ChatGPT subscription token refresh exceeded the ${timeoutMs}ms startup budget; Neondeck will retry in the background.`,
            ),
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
