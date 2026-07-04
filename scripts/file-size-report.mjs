#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const roots = ['src', 'web/src'];
const threshold = 400;
const extensions = new Set(['.ts', '.tsx']);

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(path, files);
      continue;
    }

    if (!entry.isFile()) continue;
    if (!extensions.has(extname(entry.name))) continue;
    if (entry.name.includes('.test.')) continue;
    if (entry.name.includes('.spec.')) continue;

    files.push(path);
  }

  return files;
}

const rows = roots
  .flatMap((root) => collectFiles(root))
  .map((file) => {
    const contents = readFileSync(file, 'utf8');
    const newlineCount = contents.match(/\n/g)?.length ?? 0;
    const lines =
      contents === '' || contents.endsWith('\n')
        ? newlineCount
        : newlineCount + 1;
    return { file: relative(process.cwd(), file), lines };
  })
  .filter((row) => row.lines > threshold)
  .sort(
    (left, right) =>
      right.lines - left.lines || left.file.localeCompare(right.file),
  );

for (const row of rows) {
  console.log(`${row.lines.toString().padStart(5, ' ')} ${row.file}`);
}
