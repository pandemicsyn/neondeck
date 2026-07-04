#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliEntry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const child = spawn(
  process.execPath,
  ['--import', tsxLoader, cliEntry, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env,
  },
);

child.once('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
