import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}
