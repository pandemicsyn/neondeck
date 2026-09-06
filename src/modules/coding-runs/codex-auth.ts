import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { readBounded, privateDirectory } from './host-io.ts';

// Only known Codex credential fields are selected; arbitrary auth metadata is
// neither scanned nor persisted in manifests/receipts.
const credential = v.optional(v.nullable(v.string()));
const authSchema = v.object({
  OPENAI_API_KEY: credential,
  tokens: v.optional(
    v.nullable(
      v.object({
        access_token: credential,
        refresh_token: credential,
        id_token: credential,
      }),
    ),
  ),
});
export async function selectedCredentialRedactor(directory: string) {
  let auth: v.InferOutput<typeof authSchema>;
  try {
    auth = v.parse(
      authSchema,
      JSON.parse(
        await readBounded(join(directory, 'home/.codex/auth.json'), 128 * 1024),
      ),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return (text: string) => text;
    throw new Error('Invalid selected Codex credential snapshot');
  }
  const values = [
    auth.OPENAI_API_KEY,
    auth.tokens?.access_token,
    auth.tokens?.refresh_token,
    auth.tokens?.id_token,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const secrets = [
    ...new Set(
      values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const secret of secrets) {
      text = text.replaceAll(secret, '[REDACTED]');
    }
    return text;
  };
}

// Deletes only the per-attempt copy after proven dead compute. This never
// contacts the provider or revokes the operator's selected credential.
export async function removeAttemptCredentials(
  directory: string,
): Promise<'removed' | 'absent' | 'failed'> {
  try {
    const home = join(directory, 'home/.codex');
    await privateDirectory(home);
    await unlink(join(home, 'auth.json'));
    return 'removed';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return 'absent';
    return 'failed';
  }
}
