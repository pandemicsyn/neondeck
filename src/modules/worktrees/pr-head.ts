import { runExecFile } from '../../lib/exec';

export type ExactPrHeadFetch = {
  fetchSource: string;
  fetchRef: string;
  temporaryRef: string;
  resolvedSha: string;
  fork: boolean;
};

export async function fetchExactPullRequestHead(
  input: {
    sourceRepoPath: string;
    baseRepoFullName: string;
    headRepoFullName: string;
    prNumber: number;
    headRef: string;
    headSha: string;
  },
  dependencies: {
    runGit?: (cwd: string, args: string[]) => Promise<string>;
    resolveForkRemote?: (input: {
      originUrl: string;
      headRepoFullName: string;
    }) => string;
  } = {},
): Promise<ExactPrHeadFetch> {
  const runGit = dependencies.runGit ?? boundedNoninteractiveGit;
  const fork =
    input.baseRepoFullName.toLowerCase() !==
    input.headRepoFullName.toLowerCase();
  const originUrl = (
    await runGit(input.sourceRepoPath, ['remote', 'get-url', 'origin'])
  ).trim();
  const fetchSource = fork
    ? (dependencies.resolveForkRemote?.({
        originUrl,
        headRepoFullName: input.headRepoFullName,
      }) ?? deriveForkRemote(originUrl, input.headRepoFullName))
    : 'origin';
  if (fork) assertSafeResolvedForkRemote(fetchSource);
  const fetchRef = fork
    ? `refs/heads/${input.headRef}`
    : `refs/pull/${input.prNumber}/head`;
  const temporaryRef = `refs/neondeck/autopilot/pr-${input.prNumber}`;

  try {
    await runGit(input.sourceRepoPath, [
      'fetch',
      '--no-tags',
      '--force',
      fetchSource,
      `${fetchRef}:${temporaryRef}`,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redactedSource = redactRemote(fetchSource);
    throw new Error(
      `Could not fetch exact PR head from ${redactedSource}: ${redactCredentialedUrls(message.replaceAll(fetchSource, redactedSource))}`,
    );
  }
  const [fetchedSha, expectedObjectSha] = await Promise.all([
    runGit(input.sourceRepoPath, [
      'rev-parse',
      '--verify',
      `${temporaryRef}^{commit}`,
    ]),
    runGit(input.sourceRepoPath, [
      'rev-parse',
      '--verify',
      `${input.headSha}^{commit}`,
    ]),
  ]);
  const resolvedSha = fetchedSha.trim();
  if (
    resolvedSha !== input.headSha ||
    expectedObjectSha.trim() !== input.headSha
  ) {
    throw new Error(
      `Fetched PR head ${resolvedSha || 'unknown'} does not match GitHub head ${input.headSha}.`,
    );
  }

  return {
    fetchSource: redactRemote(fetchSource),
    fetchRef,
    temporaryRef,
    resolvedSha,
    fork,
  };
}

function assertSafeResolvedForkRemote(remote: string) {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) return;
  const parsed = new URL(remote);
  const allowedProtocols = new Set([
    'file:',
    'ftp:',
    'ftps:',
    'git:',
    'http:',
    'https:',
    'ssh:',
  ]);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(
      `Resolved fork fetch URL protocol ${parsed.protocol} is not supported. Configure an SSH, Git, HTTP(S), FTP(S), or file remote.`,
    );
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      'Resolved fork fetch URLs must not embed credentials or secret-bearing query data. Configure an SSH remote or a Git credential helper instead.',
    );
  }
}

const exactHeadFetchTimeoutMs = 30_000;

async function boundedNoninteractiveGit(cwd: string, args: string[]) {
  const result = await runExecFile('git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeoutMs: exactHeadFetchTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

export function deriveForkRemote(originUrl: string, headRepoFullName: string) {
  if (/^https?:\/\//i.test(originUrl) || /^ssh:\/\//i.test(originUrl)) {
    const parsed = new URL(originUrl);
    if (parsed.protocol === 'ssh:') {
      if (parsed.port) {
        throw new Error(
          'Cannot derive a credential-safe fork remote from an SSH URL with a custom port. Configure an explicit scp-style fork remote resolver.',
        );
      }
      return `${parsed.username ? `${parsed.username}@` : ''}${parsed.hostname}:${headRepoFullName}.git`;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.pathname = `/${headRepoFullName}.git`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  }
  const scpLike = originUrl.match(/^([^@\s]+@)?([^:\s]+):(.+)$/);
  if (scpLike) {
    return `${scpLike[1] ?? ''}${scpLike[2]}:${headRepoFullName}.git`;
  }
  throw new Error(
    'Cannot derive the fork fetch remote from this origin transport. Configure an explicit fork remote resolver.',
  );
}

function redactRemote(remote: string) {
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    return remote;
  }
  const parsed = new URL(remote);
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function redactCredentialedUrls(value: string) {
  return value.replace(/\b([a-z][a-z\d+.-]*):\/\/[^/\s@]+@/gi, '$1://');
}
