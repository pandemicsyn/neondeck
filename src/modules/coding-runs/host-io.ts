import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';

export async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      'Attempt directory must be private, owned, and not a symlink',
    );
  }
  if ((await realpath(directory)) !== directory)
    throw new Error('Attempt directory must be canonical');
}
export async function readBytesBounded(path: string, limit = 2 * 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error('Invalid or oversized host artifact');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('Oversized host artifact');
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(join(path, '..'), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
function mac(token: string, payload: string) {
  return createHmac('sha256', token).update(payload).digest('hex');
}
export async function writeSigned(path: string, token: string, value: unknown) {
  await atomicWrite(path, signedEnvelope(token, value));
}
export async function readSigned(
  path: string,
  token: string,
): Promise<unknown> {
  return decodeSigned(await readBounded(path), token);
}
export function signedEnvelope(token: string, value: unknown) {
  const payload = JSON.stringify(value);
  return JSON.stringify({ payload, signature: mac(token, payload) });
}
export function decodeSigned(text: string, token: string): unknown {
  const envelope = v.parse(
    v.strictObject({
      payload: v.string(),
      signature: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    }),
    JSON.parse(text),
  );
  if (
    !timingSafeEqual(
      Buffer.from(envelope.signature, 'hex'),
      Buffer.from(mac(token, envelope.payload), 'hex'),
    )
  )
    throw new Error('Host artifact authentication failed');
  return JSON.parse(envelope.payload);
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function readBounded(path: string, limit = 2 * 1024 * 1024) {
  return (await readBytesBounded(path, limit)).toString('utf8');
}
