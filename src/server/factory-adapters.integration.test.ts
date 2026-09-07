import { it } from 'vitest';
import { runDeliveryIntegration } from './factory-adapters-delivery.test-helper';

// Real provider-specific fake subprocesses through the production factory host.
// OpenCode/Kilo retain their Linux-only platform gate. Non-Linux skips are not
// provider acceptance; the complete six-case matrix must also run on Linux.
for (const provider of ['codex', 'opencode', 'kilo'] as const) {
  const providerTest = it.skipIf(
    provider !== 'codex' && process.platform !== 'linux',
  );
  providerTest(
    `pinned ${provider} adapter: initial coding and pre-publication repair`,
    () => runDeliveryIntegration('prepublish-repair', provider),
    360000,
  );
  providerTest(
    `pinned ${provider} adapter: initial coding and watched-feedback repair`,
    () => runDeliveryIntegration('repair', provider),
    360000,
  );
}
