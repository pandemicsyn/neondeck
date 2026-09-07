import * as v from 'valibot';
import type { LocalConfig, SelectedAuth } from './contract.ts';
import { kiloModelSchema } from './kilo-model.ts';

export const kiloCredentialPath = 'home/.local/share/kilo/auth.json';
const key = v.pipe(v.string(), v.minLength(1), v.maxLength(16384));
// Exactly one selected Kilo Gateway key. OAuth/account/wellknown entries can
// import organization configuration and are deliberately outside this contract.
const auth = v.strictObject({
  kilo: v.strictObject({ type: v.literal('api'), key }),
});
const selectedSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('api-key'), value: key }),
  v.strictObject({
    kind: v.literal('auth-json'),
    value: v.pipe(v.string(), v.maxLength(128 * 1024)),
  }),
]);

function parseAuth(content: string) {
  if (Buffer.byteLength(content) > 128 * 1024)
    throw new Error('Invalid selected Kilo credentials');
  try {
    const raw: unknown = JSON.parse(content);
    return v.parse(auth, raw);
  } catch {
    throw new Error('Invalid selected Kilo credentials');
  }
}

export function kiloCredentials(
  selected: SelectedAuth | undefined,
  config: LocalConfig,
) {
  if (!v.is(kiloModelSchema, config.model))
    throw new Error('Unsupported Kilo credential provider');
  if (!selected) throw new Error('Kilo Gateway API key is required');
  const parsed = v.safeParse(selectedSchema, selected);
  if (!parsed.success) throw new Error('Invalid selected Kilo credentials');
  const value =
    parsed.output.kind === 'api-key'
      ? { kilo: { type: 'api' as const, key: parsed.output.value } }
      : parseAuth(parsed.output.value);
  return {
    files: [{ path: kiloCredentialPath, content: JSON.stringify(value) }],
    secrets: [value.kilo.key],
  };
}

export function kiloCredentialSecrets(
  contents: readonly string[],
  config: LocalConfig,
): string[] {
  if (!v.is(kiloModelSchema, config.model))
    throw new Error('Unsupported Kilo credential provider');
  if (contents.length !== 1)
    throw new Error('Expected one Kilo credential file');
  return contents.map((content) => parseAuth(content).kilo.key);
}
