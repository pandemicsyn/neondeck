import { runExecFile } from './exec';

const schedulerGitTimeoutMs = 20_000;
const schedulerGitMaxBuffer = 4 * 1024 * 1024;

export async function runBoundedGit(cwd: string, args: string[]) {
  const { stdout } = await runExecFile('git', args, {
    cwd,
    timeoutMs: schedulerGitTimeoutMs,
    maxBuffer: schedulerGitMaxBuffer,
  });
  return stdout.trim();
}

export async function runBoundedGitLines(cwd: string, args: string[]) {
  return (await runBoundedGit(cwd, args))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
