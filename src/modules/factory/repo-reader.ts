import { execFile } from 'node:child_process';
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
