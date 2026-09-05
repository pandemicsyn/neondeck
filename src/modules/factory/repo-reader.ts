import { execFile, execFileSync } from 'node:child_process';
function git(path: string, args: string[], maxBuffer = 64000) {
  return execFileSync('git', ['--no-pager', '-C', path, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer,
    env: {
      PATH: process.env.PATH,
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function captureRepoCommit(path: string | null) {
  if (!path) return null;
  try {
    const sha = git(path, ['rev-parse', '--verify', 'HEAD']).trim();
    return /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
export async function gitAsync(
  path: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 64000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', '-C', path, ...args],
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer,
        signal,
        env: {
          PATH: process.env.PATH,
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
