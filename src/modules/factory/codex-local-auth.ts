import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import * as v from 'valibot';
import { isAbsolute, join } from 'node:path';

const maxBytes = 131072;
const unavailable =
  'Local Codex auth.json is unavailable or invalid. Keyring-only logins cannot be reused here. Use a file-backed Codex login or an explicit credential environment reference.';
const credential = v.optional(v.nullable(v.string()));
const localAuthSchema = v.pipe(
  v.object({
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
  }),
  v.check((auth) =>
    Boolean(auth.OPENAI_API_KEY?.trim() || auth.tokens?.access_token?.trim()),
  ),
);

/** Reads only the selected file, with bounded IO and content-free errors. */
export function readLocalCodexAuth(path: string): {
  kind: 'auth-json';
  value: string;
} {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || !path.endsWith('/auth.json')) throw new Error();
    // No symlinks or blocking special files, including replacement races.
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes)
      throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (!length || length > maxBytes) throw new Error();
    const value = buffer.subarray(0, length).toString('utf8');
    v.parse(localAuthSchema, JSON.parse(value));
    return { kind: 'auth-json', value };
  } catch {
    throw new Error(unavailable);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Cleanup errors must not expose filesystem details or mask validation.
      }
    }
  }
}

/** Discovery never returns credentials, scans directories, or accesses keychains.
 * A missing file cannot distinguish a keyring-only login from no login.
 * Each launch snapshots this file; OAuth refreshes are never written back.
 */
export function discoverLocalCodexAuth(
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): { available: boolean; path: string; reason: string | null } {
  const env = options.env ?? process.env;
  const path = join(
    env.CODEX_HOME || join(options.home ?? homedir(), '.codex'),
    'auth.json',
  );
  try {
    readLocalCodexAuth(path);
    return { available: true, path, reason: null };
  } catch {
    return { available: false, path, reason: unavailable };
  }
}
