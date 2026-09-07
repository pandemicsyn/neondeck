import * as v from 'valibot';
import { configSchema } from './host-contract.ts';
import { inspectCodingAdapterReadiness } from './adapter-host.ts';
// Compatibility API for callers of the original Codex-only host.
export async function inspectCodexReadiness(input: unknown, home: string) {
  const config = v.parse(configSchema, input);
  if (config.adapter && config.adapter.id !== 'codex')
    return { ready: false, version: null, reason: 'unsupported-cli-version' };
  return inspectCodingAdapterReadiness(config, home);
}
