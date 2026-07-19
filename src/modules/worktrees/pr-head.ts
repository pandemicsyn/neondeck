import { runUnattendedGit } from '../../lib/git';

export type ExactPrHeadFetch = {
  baseRemote: string;
  fetchSource: string;
  fetchRef: string;
  temporaryRef: string;
  resolvedSha: string;
  fork: boolean;
};

export type ExactPrHeadTarget = Omit<ExactPrHeadFetch, 'resolvedSha'>;

type ExactPrHeadInput = {
  sourceRepoPath: string;
  baseRepoFullName: string;
  headRepoFullName: string;
  prNumber: number;
  headRef: string;
  headSha: string;
};

type ExactPrHeadDependencies = {
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  resolveForkRemote?: (input: {
    originUrl: string;
    headRepoFullName: string;
  }) => string;
};

export async function fetchExactPullRequestHead(
  input: ExactPrHeadInput,
  dependencies: ExactPrHeadDependencies = {},
): Promise<ExactPrHeadFetch> {
  const runGit = dependencies.runGit ?? boundedNoninteractiveGit;
  const target = await resolveExactPullRequestHeadTarget(input, dependencies);

  try {
    await runGit(input.sourceRepoPath, [
      'fetch',
      '--no-tags',
      '--force',
      '--',
      target.fetchSource,
      `${target.fetchRef}:${target.temporaryRef}`,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redactedSource = redactRemote(target.fetchSource);
    throw new Error(
      `Could not fetch exact PR head from ${redactedSource}: ${redactCredentialedUrls(message.replaceAll(target.fetchSource, redactedSource))}`,
    );
  }
  const [fetchedSha, expectedObjectSha] = await Promise.all([
    runGit(input.sourceRepoPath, [
      'rev-parse',
      '--verify',
      `${target.temporaryRef}^{commit}`,
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
    ...target,
    resolvedSha,
  };
}

export async function probeExactPullRequestHead(
  input: ExactPrHeadInput,
  dependencies: ExactPrHeadDependencies = {},
) {
  const runGit = dependencies.runGit ?? boundedNoninteractiveGit;
  const target = await resolveExactPullRequestHeadTarget(input, dependencies);
  const output = await runGit(input.sourceRepoPath, [
    'ls-remote',
    '--exit-code',
    '--refs',
    '--',
    target.fetchSource,
    target.fetchRef,
  ]);
  const resolvedSha = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, ref]) => ref === target.fetchRef)?.[0];
  if (resolvedSha !== input.headSha) {
    throw new Error(
      `Remote PR head ${resolvedSha ?? 'unknown'} does not match GitHub head ${input.headSha}.`,
    );
  }
  return { ...target, resolvedSha };
}

export async function resolveExactPullRequestHeadTarget(
  input: ExactPrHeadInput,
  dependencies: ExactPrHeadDependencies = {},
): Promise<ExactPrHeadTarget> {
  const runGit = dependencies.runGit ?? boundedNoninteractiveGit;
  assertSafePullRequestHeadInput(input);
  const fork =
    input.baseRepoFullName.toLowerCase() !==
    input.headRepoFullName.toLowerCase();
  const baseRemote = await resolveRegisteredRepositoryRemote(
    input.sourceRepoPath,
    input.baseRepoFullName,
    runGit,
  );
  const fetchSource = fork
    ? (dependencies.resolveForkRemote?.({
        originUrl: baseRemote.url,
        headRepoFullName: input.headRepoFullName,
      }) ?? deriveForkRemote(baseRemote.url, input.headRepoFullName))
    : baseRemote.name;
  if (fork) assertSafeResolvedForkRemote(fetchSource);
  else assertSafeRemoteName(fetchSource);
  return {
    baseRemote: baseRemote.name,
    fetchSource,
    fetchRef: fork
      ? `refs/heads/${input.headRef}`
      : `refs/pull/${input.prNumber}/head`,
    temporaryRef: `refs/neondeck/autopilot/pr-${input.prNumber}`,
    fork,
  };
}

export async function resolveRegisteredRepositoryRemote(
  sourceRepoPath: string,
  repoFullName: string,
  runGit: (
    cwd: string,
    args: string[],
  ) => Promise<string> = boundedNoninteractiveGit,
) {
  assertSafeRepoFullName(repoFullName, 'base repository');
  const names = (await runGit(sourceRepoPath, ['remote']))
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const candidates: Array<{
    name: string;
    urls: string[];
    matchingUrl: string | null;
  }> = [];
  for (const name of names) {
    assertSafeRemoteName(name);
    const urls = (
      await runGit(sourceRepoPath, ['remote', 'get-url', '--all', '--', name])
    )
      .split(/\r?\n/)
      .map((url) => url.trim())
      .filter(Boolean);
    candidates.push({
      name,
      urls,
      matchingUrl:
        urls.find(
          (url) =>
            repositoryFullNameFromRemote(url)?.toLowerCase() ===
            repoFullName.toLowerCase(),
        ) ?? null,
    });
  }
  const matches = candidates.filter((candidate) => candidate.matchingUrl);
  if (matches.length === 1) {
    const match = matches[0]!;
    return { name: match.name, url: match.matchingUrl! };
  }

  const candidateSummary = candidates.length
    ? candidates
        .map(
          (candidate) =>
            `${candidate.name}=${candidate.urls.length ? candidate.urls.map(redactRemote).join('|') : '(no URL)'}`,
        )
        .join(', ')
    : 'none';
  if (matches.length === 0) {
    throw new Error(
      `No configured Git remote matches registered repository ${repoFullName}. Candidates: ${candidateSummary}. Configure a remote whose URL identifies that repository.`,
    );
  }
  throw new Error(
    `Multiple Git remotes match registered repository ${repoFullName}: ${matches.map((candidate) => candidate.name).join(', ')}. Remove the ambiguity before preparing a PR worktree. Candidates: ${candidateSummary}.`,
  );
}

export function repositoryFullNameFromRemote(remote: string) {
  assertNoControlCharacters(remote, 'Git remote URL');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      return null;
    }
    if (parsed.search || parsed.hash) return null;
    return repoFullNameFromPath(parsed.pathname);
  }
  const scpLike = remote.match(
    /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?)$/,
  );
  return scpLike ? repoFullNameFromPath(scpLike[1]!) : null;
}

function repoFullNameFromPath(pathname: string) {
  const normalized = pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) return null;
  if (
    normalized
      .split('/')
      .some((part) => part.startsWith('-') || part === '.' || part === '..')
  ) {
    return null;
  }
  return normalized;
}

function assertSafePullRequestHeadInput(input: {
  baseRepoFullName: string;
  headRepoFullName: string;
  prNumber: number;
  headRef: string;
  headSha: string;
}) {
  assertSafeRepoFullName(input.baseRepoFullName, 'base repository');
  assertSafeRepoFullName(input.headRepoFullName, 'head repository');
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    throw new Error('Pull request number must be a positive safe integer.');
  }
  if (!/^[a-f0-9]{40}$/.test(input.headSha)) {
    throw new Error('GitHub head SHA must be a complete lowercase SHA-1.');
  }
  assertSafeGitBranch(input.headRef);
}

function assertSafeRepoFullName(value: string, label: string) {
  assertNoControlCharacters(value, label);
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    value
      .split('/')
      .some((part) => part.startsWith('-') || part === '.' || part === '..')
  ) {
    throw new Error(
      `${label} must be an owner/name identifier without option-like or URL syntax.`,
    );
  }
}

function assertSafeGitBranch(value: string) {
  assertNoControlCharacters(value, 'PR head ref');
  if (
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    /[ ~^:?*\\[\]]/.test(value) ||
    value
      .split('/')
      .some((part) => part.endsWith('.lock') || part.startsWith('.'))
  ) {
    throw new Error('PR head ref is not a safe Git branch name.');
  }
}

function assertSafeRemoteName(value: string) {
  assertNoControlCharacters(value, 'Git remote name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('Git remote name contains unsafe or option-like syntax.');
  }
}

function assertNoControlCharacters(value: string, label: string) {
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!value || containsControlCharacter) {
    throw new Error(`${label} contains control characters or is empty.`);
  }
}

function assertSafeResolvedForkRemote(remote: string) {
  assertNoControlCharacters(remote, 'Resolved fork fetch remote');
  if (remote.startsWith('-')) {
    throw new Error('Resolved fork fetch remote must not be option-like.');
  }
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    if (
      !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        remote,
      )
    ) {
      throw new Error(
        'Resolved fork fetch remote must be a strict URL or scp-style repository address.',
      );
    }
    return;
  }
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

async function boundedNoninteractiveGit(cwd: string, args: string[]) {
  return runUnattendedGit(cwd, args);
}

export function deriveForkRemote(originUrl: string, headRepoFullName: string) {
  assertSafeRepoFullName(headRepoFullName, 'head repository');
  assertNoControlCharacters(originUrl, 'base Git remote URL');
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
  const scpLike = originUrl.match(
    /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/,
  );
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
  try {
    const parsed = new URL(remote);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid remote URL]';
  }
}

function redactCredentialedUrls(value: string) {
  return value.replace(/\b([a-z][a-z\d+.-]*):\/\/[^/\s@]+@/gi, '$1://');
}
