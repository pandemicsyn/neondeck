import { execFile, spawn } from 'node:child_process';
export type RepoWorkflowEvidence = {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
};
const maxEvidenceBytes = 4096;
function gitEnvironment() {
  return {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}
const sourcePaths = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  '.nvmrc',
  '.node-version',
  'README.md',
  'CONTRIBUTING.md',
  'AGENTS.md',
];
// Match the planning reader's read-only, credential-free Git boundary. Only
// allowlisted regular blobs from a captured commit are available to the model.
async function git(
  root: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 32_000,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['--no-pager', '-C', root, ...args],
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer,
        signal,
        env: gitEnvironment(),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
// Retain only the prefix and stop the producer at the byte budget. Unlike
// execFile's maxBuffer, truncating a large blob is a successful evidence read.
function readBlobPrefix(
  root: string,
  objectId: string,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      ['--no-pager', '-C', root, 'cat-file', 'blob', objectId],
      {
        signal,
        timeout: 3000,
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stoppedAtLimit = false;
    child.stdout.on('data', (chunk: Buffer) => {
      const retained = chunk.subarray(0, maxEvidenceBytes - size);
      if (retained.length) chunks.push(Buffer.from(retained));
      size += retained.length;
      if (size === maxEvidenceBytes && !stoppedAtLimit) {
        stoppedAtLimit = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal.aborted) reject(signal.reason);
      else if (code === 0 || stoppedAtLimit)
        resolve(Buffer.concat(chunks, size));
      else reject(new Error('Committed evidence blob could not be read.'));
    });
  });
}
export async function collectRepoWorkflowEvidence(root: string) {
  const signal = AbortSignal.timeout(10_000);
  const revision = (
    await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)
  ).trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('Repository has no readable committed revision.');
  const ci = (
    await git(
      root,
      ['ls-tree', '--name-only', `${revision}:.github/workflows`],
      signal,
    ).catch(() => '')
  )
    .split('\n')
    .filter((name) => /^[a-zA-Z0-9_.-]+\.ya?ml$/.test(name))
    .sort()
    .slice(0, 8)
    .map((name) => `.github/workflows/${name}`);
  const evidence: RepoWorkflowEvidence[] = [];
  for (const path of [...sourcePaths, ...ci]) {
    signal.throwIfAborted();
    try {
      const mode = await git(
        root,
        ['ls-tree', '-l', revision, '--', path],
        signal,
      );
      const entry = /^100(?:644|755) blob ([a-f0-9]{40,64})\s+(\d+)\t/.exec(
        mode,
      );
      if (!entry) continue;
      const sizeBytes = Number(entry[2]);
      if (!Number.isSafeInteger(sizeBytes)) continue;
      const prefix = await readBlobPrefix(root, entry[1], signal);
      const content = new TextDecoder().decode(prefix, { stream: true });
      if (!content.includes('\0'))
        evidence.push({
          path,
          content,
          sizeBytes,
          truncated: sizeBytes > prefix.length,
        });
    } catch {
      signal.throwIfAborted();
    }
  }
  return { revision, evidence };
}
