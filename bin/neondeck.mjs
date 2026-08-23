#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliEntry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const tsxLoader = import.meta.resolve('tsx');
const child = spawn(
  process.execPath,
  ['--import', tsxLoader, cliEntry, ...process.argv.slice(2)],
  {
    // Keep terminal signals on this wrapper's process group. The wrapper
    // forwards each signal once, so the CLI does not receive both the
    // terminal signal and a forwarded duplicate.
    detached: true,
    windowsHide: true,
    stdio: 'inherit',
    env: process.env,
  },
);
let stoppingSignal = null;
const forwardSignal = (signal) => {
  if (stoppingSignal) return;
  stoppingSignal = signal;
  child.kill(signal);
};
const forwardSigint = () => forwardSignal('SIGINT');
const forwardSigterm = () => forwardSignal('SIGTERM');
process.on('SIGINT', forwardSigint);
process.on('SIGTERM', forwardSigterm);

function cleanupSignalHandlers() {
  process.off('SIGINT', forwardSigint);
  process.off('SIGTERM', forwardSigterm);
}

child.once('error', (error) => {
  cleanupSignalHandlers();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.once('exit', (code, signal) => {
  cleanupSignalHandlers();
  if (signal) {
    process.exitCode =
      signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    return;
  }
  process.exit(code ?? 0);
});
