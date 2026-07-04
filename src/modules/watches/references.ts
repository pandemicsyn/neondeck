import type { RepoRegistrySnapshot } from '../../repos';
import { repoFullName } from '../../repos';
import type {
  DesiredTerminalState,
  ResolvedPrReference,
  ResolvedRefReference,
  WatchActionResult,
} from './schemas';
import { failResult } from './utils';

export function parseWatchPrReference(
  input: string,
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
  desiredTerminalState?: DesiredTerminalState,
) {
  return resolvePrReference(input, registry, desiredTerminalState);
}

export function parseWatchRefReference(
  input: { repo?: string; ref?: string; target?: string },
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
) {
  return resolveRefReference(input, registry);
}

export function resolvePrReference(
  input: string,
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
  explicitDesiredTerminalState?: DesiredTerminalState,
):
  | { ok: true; reference: ResolvedPrReference }
  | { ok: false; result: WatchActionResult } {
  const desiredFromInput = readDesiredTerminalState(input);
  const desiredTerminalState =
    explicitDesiredTerminalState ?? desiredFromInput.state ?? 'checks';
  const ref = desiredFromInput.ref;
  const urlMatch = ref.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/i,
  );

  if (urlMatch) {
    return okReference({
      repoId: `${urlMatch[1]}/${urlMatch[2]}`,
      githubOwner: urlMatch[1],
      githubName: urlMatch[2],
      prNumber: Number(urlMatch[3]),
      desiredTerminalState,
    });
  }

  const fullNameMatch = ref.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (fullNameMatch) {
    return okReference({
      repoId: `${fullNameMatch[1]}/${fullNameMatch[2]}`,
      githubOwner: fullNameMatch[1],
      githubName: fullNameMatch[2],
      prNumber: Number(fullNameMatch[3]),
      desiredTerminalState,
    });
  }

  const repoMatch = ref.match(/^([^#\s]+)#(\d+)$/);
  if (repoMatch) {
    const repo = findConfiguredRepo(registry.repos, repoMatch[1]);
    if (!repo.ok) return repo;

    return okReference({
      repoId: repo.repo.id,
      githubOwner: repo.repo.github.owner,
      githubName: repo.repo.github.name,
      prNumber: Number(repoMatch[2]),
      desiredTerminalState,
    });
  }

  const numberMatch = ref.match(/^#(\d+)$/);
  if (numberMatch) {
    if (registry.repos.length !== 1) {
      return {
        ok: false,
        result: failResult(
          'watch_pr_parse',
          'A bare PR number requires exactly one configured repo.',
          { requires: ['repo'] },
        ),
      };
    }

    const repo = registry.repos[0];
    return okReference({
      repoId: repo.id,
      githubOwner: repo.github.owner,
      githubName: repo.github.name,
      prNumber: Number(numberMatch[1]),
      desiredTerminalState,
    });
  }

  return {
    ok: false,
    result: failResult(
      'watch_pr_parse',
      `Could not parse PR reference "${input}".`,
      {
        requires: ['ref'],
      },
    ),
  };
}

export function resolveRefReference(
  input: { repo?: string; ref?: string; target?: string },
  registry: Pick<RepoRegistrySnapshot, 'repos'>,
):
  | { ok: true; reference: ResolvedRefReference }
  | { ok: false; result: WatchActionResult } {
  const normalized = normalizeRefInput(input);
  if (!normalized.ok) return normalized;

  const fullNameMatch = normalized.repo.match(/^([^/\s@]+)\/([^/\s@]+)$/);
  if (fullNameMatch) {
    return okRefReference({
      repoId: `${fullNameMatch[1]}/${fullNameMatch[2]}`,
      githubOwner: fullNameMatch[1],
      githubName: fullNameMatch[2],
      ref: normalized.ref,
    });
  }

  const repo = findConfiguredRepo(registry.repos, normalized.repo);
  if (!repo.ok) {
    return {
      ok: false,
      result: {
        ...repo.result,
        action: 'watch_ref_parse',
      },
    };
  }

  return okRefReference({
    repoId: repo.repo.id,
    githubOwner: repo.repo.github.owner,
    githubName: repo.repo.github.name,
    ref: normalized.ref,
  });
}

export function normalizeRefInput(input: {
  repo?: string;
  ref?: string;
  target?: string;
}):
  | { ok: true; repo: string; ref: string }
  | { ok: false; result: WatchActionResult } {
  if (input.repo && input.ref) {
    const repo = input.repo.trim();
    const ref = input.ref.trim();
    if (repo && ref) {
      return { ok: true, repo, ref };
    }
  }

  const target = input.target?.trim();
  if (!target) {
    return {
      ok: false,
      result: failResult(
        'watch_ref_parse',
        'A repo/ref pair or target such as "repo@branch" is required.',
        { requires: ['repo', 'ref'] },
      ),
    };
  }

  const urlMatch = target.match(
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:tree|commit|commits)\/(.+)$/i,
  );
  if (urlMatch) {
    return {
      ok: true,
      repo: `${urlMatch[1]}/${urlMatch[2]}`,
      ref: decodeURIComponent(urlMatch[3].replace(/\/$/, '')),
    };
  }

  const atIndex = target.indexOf('@');
  if (atIndex > 0 && atIndex < target.length - 1) {
    return {
      ok: true,
      repo: target.slice(0, atIndex).trim(),
      ref: target.slice(atIndex + 1).trim(),
    };
  }

  return {
    ok: false,
    result: failResult(
      'watch_ref_parse',
      `Could not parse ref watch target "${target}".`,
      { requires: ['target'] },
    ),
  };
}

export function okRefReference(
  input: Omit<ResolvedRefReference, 'id' | 'repoFullName'>,
): {
  ok: true;
  reference: ResolvedRefReference;
} {
  const repoFullNameValue = `${input.githubOwner}/${input.githubName}`;
  const reference = {
    ...input,
    repoFullName: repoFullNameValue,
    id: `${repoFullNameValue}@${input.ref}`,
  };

  return { ok: true, reference };
}

export function readDesiredTerminalState(input: string) {
  const match = input.match(/\s+until\s+(prod|checks|merged?)\s*$/i);
  if (!match) return { ref: input.trim(), state: undefined };

  const rawState = match[1].toLowerCase();
  const state: DesiredTerminalState = rawState.startsWith('merge')
    ? 'merged'
    : (rawState as DesiredTerminalState);

  return {
    ref: input.slice(0, match.index).trim(),
    state,
  };
}

export function findConfiguredRepo(
  repos: RepoRegistrySnapshot['repos'],
  value: string,
):
  | { ok: true; repo: RepoRegistrySnapshot['repos'][number] }
  | { ok: false; result: WatchActionResult } {
  const matches = repos.filter(
    (repo) =>
      repo.id === value ||
      repo.github.name === value ||
      repoFullName(repo).toLowerCase() === value.toLowerCase(),
  );

  if (matches.length === 1) {
    return { ok: true, repo: matches[0] };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      result: failResult(
        'watch_pr_parse',
        `Repository "${value}" is ambiguous.`,
        {
          requires: ['repo'],
        },
      ),
    };
  }

  return {
    ok: false,
    result: failResult(
      'watch_pr_parse',
      `Repository "${value}" is not configured.`,
      {
        requires: ['repo'],
      },
    ),
  };
}

export function okReference(
  input: Omit<ResolvedPrReference, 'id' | 'repoFullName'>,
): {
  ok: true;
  reference: ResolvedPrReference;
} {
  const repoFullNameValue = `${input.githubOwner}/${input.githubName}`;
  const reference = {
    ...input,
    repoFullName: repoFullNameValue,
    id: `${repoFullNameValue}#${input.prNumber}`,
  };

  return { ok: true, reference };
}
