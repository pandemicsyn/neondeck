import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

copyDirectory('src/runtime-home/app-db/migrations', 'dist/assets/migrations');
copyDirectory('src/skills', 'dist/assets/skills');
copyDirectory('src/skills', 'dist/skills');
copyDirectory('config', 'dist/config');
copyFile('SOUL.md', 'dist/SOUL.md');

function copyDirectory(from, to) {
  const source = join(root, from);
  const target = join(root, to);
  if (!existsSync(source)) {
    throw new Error(`Missing runtime asset source: ${from}`);
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyFile(from, to) {
  const source = join(root, from);
  const target = join(root, to);
  if (!existsSync(source)) {
    throw new Error(`Missing runtime asset source: ${from}`);
  }
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(source, target);
}
