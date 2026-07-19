import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  evaluateGitPushAccess,
  probeGitPushAccess,
  runUnattendedGit,
} from '../../lib/git';
import {
  defaultRepoGuardrails,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  repoGuardrailsSchema,
  runtimePaths,
  type AppConfig,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import {
  fetchPullRequestEventState,
  githubFetch,
  pullRequestEventStateTruncation,
  type GitHubPullRequestEventState,
} from '../github';
import {
  evaluateExecutionPolicy,
  executionPolicyFromConfig,
} from '../execution-policy';
import {
  probeExactPullRequestHead,
  resolvePrPushTargetForCheckout,
  type PrPushTarget,
} from '../worktrees';

export type AutopilotMode =
  | 'notify-only'
  | 'prepare-only'
  | 'autofix-with-approval'
  | 'autofix-push-when-safe';

const execFileAsync = promisify(execFile);
const readinessCommandTimeoutMs = 10_000;
const githubRepositoryMetadataSchema = v.object({
  private: v.boolean(),
  permissions: v.object({ push: v.boolean() }),
});
const githubIdentitySchema = v.object({
  login: v.pipe(v.string(), v.minLength(1)),
});

export type AutopilotReadinessFactId =
  | 'runtime-home'
  | 'worktree-root'
  | 'source-repo'
  | 'api'
  | 'fetch'
  | 'git-push'
  | 'comment'
  | 'identity'
  | 'check-commands'
  | 'gh';

export type AutopilotReadinessFactStatus =
  'ready' | 'blocked' | 'warning' | 'not-required' | 'not-checked';

export type AutopilotReadinessFact = {
  id: AutopilotReadinessFactId;
  label: string;
  status: AutopilotReadinessFactStatus;
  required: boolean;
  message: string;
  action: string | null;
  details?: Record<string, unknown>;
};

export type AutopilotReadiness = {
  ok: true;
  action: 'autopilot_readiness_read';
  changed: false;
  ready: boolean;
  status: 'ready' | 'blocked' | 'warning';
  message: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  mode: AutopilotMode;
  facts: Record<AutopilotReadinessFactId, AutopilotReadinessFact>;
  blocking: AutopilotReadinessFactId[];
  warnings: AutopilotReadinessFactId[];
  pushTarget: PrPushTarget | null;
  checkedAt: string;
};

export const autopilotReadinessInputSchema = v.object({
  repoId: v.pipe(v.string(), v.minLength(1)),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  mode: v.optional(
    v.picklist([
      'notify-only',
      'prepare-only',
      'autofix-with-approval',
      'autofix-push-when-safe',
    ]),
  ),
});

const factStatusSchema = v.picklist([
  'ready',
  'blocked',
  'warning',
  'not-required',
  'not-checked',
]);
const factIdSchema = v.picklist([
  'runtime-home',
  'worktree-root',
  'source-repo',
  'api',
  'fetch',
  'git-push',
  'comment',
  'identity',
  'check-commands',
  'gh',
]);
const readinessFactSchema = v.object({
  id: factIdSchema,
  label: v.string(),
  status: factStatusSchema,
  required: v.boolean(),
  message: v.string(),
  action: v.nullable(v.string()),
  details: v.optional(v.record(v.string(), v.unknown())),
});

export const autopilotReadinessSchema = v.object({
  ok: v.literal(true),
  action: v.literal('autopilot_readiness_read'),
  changed: v.literal(false),
  ready: v.boolean(),
  status: v.picklist(['ready', 'blocked', 'warning']),
  message: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.nullable(v.number()),
  mode: v.picklist([
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ]),
  facts: v.record(v.string(), readinessFactSchema),
  blocking: v.array(factIdSchema),
  warnings: v.array(factIdSchema),
  pushTarget: v.nullable(
    v.object({
      repoFullName: v.string(),
      remote: v.string(),
      branch: v.string(),
      fork: v.boolean(),
      maintainerCanModify: v.boolean(),
      canLikelyPush: v.nullable(v.boolean()),
    }),
  ),
  checkedAt: v.string(),
});

type ReadinessInput = v.InferOutput<typeof autopilotReadinessInputSchema>;

export type AutopilotReadinessDependencies = {
  env?: NodeJS.ProcessEnv;
  remoteChecks?: boolean;
  runGit?: (cwd: string, args: string[]) => Promise<string>;
  fetchEventState?: typeof fetchPullRequestEventState;
  fetchGitHub?: typeof githubFetch;
  probePushAccess?: typeof probeGitPushAccess;
  probeExactHead?: typeof probeExactPullRequestHead;
  runCommand?: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string }>;
};

export async function readAutopilotReadiness(
  rawInput: ReadinessInput,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotReadinessDependencies = {},
): Promise<AutopilotReadiness> {
  const input = v.parse(autopilotReadinessInputSchema, rawInput);
  const env = dependencies.env ?? process.env;
  const remoteChecks = dependencies.remoteChecks !== false;
  const [registry, appConfig] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === input.repoId,
  );
  if (!repo) {
    throw new Error(
      `Repository "${input.repoId}" is not configured. Add it with neondeck repo add before checking Autopilot readiness.`,
    );
  }
  const repoFullName = `${repo.github.owner}/${repo.github.name}`;
  const mode = input.mode ?? readinessMode(repo, appConfig);
  const needsWorktree = mode !== 'notify-only';
  const needsDelivery =
    mode === 'autofix-with-approval' || mode === 'autofix-push-when-safe';
  const runGit =
    dependencies.runGit ??
    ((cwd, args) => runUnattendedGit(cwd, args, { env }));

  const runtimeHome = await writableFact(
    'runtime-home',
    'Runtime home',
    paths.home,
    true,
    'Choose a writable NEONDECK_HOME and rerun setup.',
  );
  const worktreeRoot = await writableFact(
    'worktree-root',
    'Worktree root',
    paths.worktrees,
    needsWorktree,
    'Make the Neondeck worktree directory writable before enabling code-changing modes.',
  );
  const sourceRepo = await sourceRepoFact(repo.path, runGit);
  const identity = await identityFact(repo.path, mode, env, runGit);
  const checkCommands = checkCommandFact(repo, appConfig, mode);
  const gh = await ghFact(env, remoteChecks, dependencies.runCommand);

  let eventState: GitHubPullRequestEventState | null = null;
  let metadata: Awaited<ReturnType<typeof githubMetadata>> | null = null;
  let api = notCheckedFact(
    'api',
    'GitHub API',
    true,
    remoteChecks
      ? 'Provide a PR number to verify reviews, checks, annotations, permissions, and comments.'
      : 'Live GitHub API checks were skipped for this summary. Run `neondeck doctor --repo <id> --pr <number>`.',
    'Set GITHUB_TOKEN and rerun target-specific readiness.',
  );
  let fetch = modeFact(
    'fetch',
    'PR head fetch',
    needsWorktree,
    input.prNumber,
    remoteChecks,
  );
  let gitPush = modeFact(
    'git-push',
    'Git push credential',
    needsDelivery,
    input.prNumber,
    remoteChecks,
  );
  let comment = modeFact(
    'comment',
    'PR result comment',
    needsDelivery,
    input.prNumber,
    remoteChecks,
  );
  let pushTarget: PrPushTarget | null = null;

  if (remoteChecks && env.GITHUB_TOKEN) {
    try {
      metadata = await githubMetadata(
        env.GITHUB_TOKEN,
        repo.github.owner,
        repo.github.name,
        dependencies.fetchGitHub,
      );
      if (input.prNumber) {
        eventState = await (
          dependencies.fetchEventState ?? fetchPullRequestEventState
        )({
          token: env.GITHUB_TOKEN,
          owner: repo.github.owner,
          repo: repo.github.name,
          number: input.prNumber,
        });
        const truncation = pullRequestEventStateTruncation(eventState);
        const permissionsKnown = branchPermissionFactsKnown(
          eventState.branchPermissions,
        );
        api =
          truncation.any || !permissionsKnown
            ? fact(
                'api',
                'GitHub API',
                'blocked',
                true,
                truncation.any
                  ? `GitHub returned incomplete PR facts: ${truncation.categories.join(', ')}.`
                  : 'GitHub did not return complete base/head repository push permission facts.',
                'Reduce the PR fact set or restore access before admitting Autopilot.',
                {
                  scopes: metadata.scopes,
                  truncation: truncation.categories,
                  branchPermissionsKnown: permissionsKnown,
                },
              )
            : fact(
                'api',
                'GitHub API',
                'ready',
                true,
                'GitHub API can read PR metadata, reviews, comments, checks, annotations, and branch permissions.',
                null,
                {
                  scopes: metadata.scopes,
                  repositoryPush: metadata.push,
                  login: metadata.login,
                },
              );
      } else {
        api = fact(
          'api',
          'GitHub API',
          'warning',
          true,
          'GitHub repository metadata is readable; select a PR to verify review, check, annotation, permission, and comment reads.',
          'Run `neondeck doctor --repo <id> --pr <number>`.',
          {
            scopes: metadata.scopes,
            repositoryPush: metadata.push,
            login: metadata.login,
          },
        );
      }
    } catch (error) {
      api = fact(
        'api',
        'GitHub API',
        'blocked',
        true,
        `GitHub API readiness failed: ${errorMessage(error)}`,
        'Set a token with repository, pull-request, checks, and metadata read access.',
      );
    }
  } else if (remoteChecks) {
    api = fact(
      'api',
      'GitHub API',
      'blocked',
      true,
      'GITHUB_TOKEN is not configured.',
      'Set GITHUB_TOKEN in the runtime-home .env file.',
    );
  }

  if (eventState && input.prNumber) {
    const baseRepoFullName = eventState.baseRepoFullName ?? repoFullName;
    const headRepoFullName =
      eventState.headRepoFullName ??
      (eventState.headOwner && eventState.headName
        ? `${eventState.headOwner}/${eventState.headName}`
        : repoFullName);
    const headRef = eventState.headRef;
    if (needsWorktree) {
      try {
        if (!headRef)
          throw new Error('GitHub did not return the PR head branch.');
        const probed = await (
          dependencies.probeExactHead ?? probeExactPullRequestHead
        )(
          {
            sourceRepoPath: repo.path,
            baseRepoFullName,
            headRepoFullName,
            prNumber: input.prNumber,
            headRef,
            headSha: eventState.headSha,
          },
          { runGit },
        );
        fetch = fact(
          'fetch',
          'PR head fetch',
          'ready',
          true,
          `Exact ${probed.fork ? 'fork' : 'same-repo'} head ${eventState.headSha.slice(0, 12)} is reachable without prompting.`,
          null,
          probed,
        );
      } catch (error) {
        fetch = fact(
          'fetch',
          'PR head fetch',
          'blocked',
          true,
          `PR head fetch readiness failed: ${errorMessage(error)}`,
          'Configure a matching repository remote and noninteractive credentials for the PR head repository.',
        );
      }
    }

    if (needsDelivery) {
      try {
        if (!headRef)
          throw new Error('GitHub did not return the PR head branch.');
        pushTarget = await resolvePrPushTargetForCheckout(
          {
            sourceRepoPath: repo.path,
            baseRepoFullName,
            headRepoFullName,
            headRef,
            branchPermissions: eventState.branchPermissions,
          },
          { runGit },
        );
        if (pushTarget.canLikelyPush !== true) {
          throw new Error(
            pushTarget.fork && !pushTarget.maintainerCanModify
              ? `Fork ${pushTarget.repoFullName} does not allow maintainer edits and the API credential cannot push its branch.`
              : `GitHub branch permission facts do not allow push to ${pushTarget.repoFullName}:${pushTarget.branch}.`,
          );
        }
        const probed = await (
          dependencies.probePushAccess ?? probeGitPushAccess
        )(
          repo.path,
          {
            remote: pushTarget.remote,
            ref: `refs/heads/${pushTarget.branch}`,
          },
          { runGit },
        );
        if (!metadata) {
          throw new Error(
            'GitHub API identity is unavailable for the push target.',
          );
        }
        const decision = evaluateGitPushAccess(probed, {
          apiLogin: metadata.login,
          requireBoundIdentity: true,
        });
        if (probed.remote.sha !== eventState.headSha) {
          throw new Error(
            probed.remote.sha
              ? `Push target branch resolves to ${probed.remote.sha}, not current PR head ${eventState.headSha}.`
              : `Push target branch ${pushTarget.repoFullName}:${pushTarget.branch} was not found.`,
          );
        }
        gitPush = fact(
          'git-push',
          'Git push credential',
          decision.status,
          true,
          `${decision.message} Exact target ${pushTarget.repoFullName}:${pushTarget.branch} is reachable. No push was performed.`,
          decision.ready
            ? null
            : decision.status === 'warning'
              ? 'Use an HTTPS credential helper whose GitHub actor can be compared with the API actor before unattended push admission.'
              : 'Align the Git credential-helper actor with GITHUB_TOKEN and rerun readiness.',
          { target: pushTarget, probe: probed },
        );
      } catch (error) {
        gitPush = fact(
          'git-push',
          'Git push credential',
          'blocked',
          true,
          `Git push credential readiness failed: ${errorMessage(error)}`,
          'Configure a credential helper or run `gh auth setup-git`, then rerun readiness for this PR.',
          pushTarget ? { target: pushTarget } : undefined,
        );
      }
    }

    comment = commentFact(needsDelivery, metadata);
  }

  const facts = indexFacts([
    runtimeHome,
    worktreeRoot,
    sourceRepo,
    api,
    fetch,
    gitPush,
    comment,
    identity,
    checkCommands,
    gh,
  ]);
  const blocking = Object.values(facts)
    .filter((item) => item.required && item.status === 'blocked')
    .map((item) => item.id);
  const warnings = Object.values(facts)
    .filter(
      (item) =>
        item.status === 'warning' ||
        (item.required && item.status === 'not-checked'),
    )
    .map((item) => item.id);
  const ready = blocking.length === 0 && warnings.length === 0;
  const status = blocking.length > 0 ? 'blocked' : ready ? 'ready' : 'warning';
  return {
    ok: true,
    action: 'autopilot_readiness_read',
    changed: false,
    ready,
    status,
    message: ready
      ? `${repoFullName}${input.prNumber ? `#${input.prNumber}` : ''} is ready for ${mode}.`
      : `${repoFullName}${input.prNumber ? `#${input.prNumber}` : ''} ${mode} readiness has ${blocking.length} blocker${blocking.length === 1 ? '' : 's'} and ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`,
    repoId: repo.id,
    repoFullName,
    prNumber: input.prNumber ?? null,
    mode,
    facts,
    blocking,
    warnings,
    pushTarget,
    checkedAt: new Date().toISOString(),
  };
}

async function writableFact(
  id: 'runtime-home' | 'worktree-root',
  label: string,
  path: string,
  required: boolean,
  action: string,
) {
  try {
    await access(path, fsConstants.W_OK);
    return fact(id, label, 'ready', required, `${path} is writable.`, null, {
      path,
    });
  } catch (error) {
    return fact(
      id,
      label,
      'blocked',
      required,
      `${path} is not writable: ${errorMessage(error)}`,
      action,
      { path },
    );
  }
}

async function sourceRepoFact(
  path: string,
  runGit: (cwd: string, args: string[]) => Promise<string>,
) {
  try {
    const resolved = await realpath(path);
    const inside = (
      await runGit(resolved, ['rev-parse', '--is-inside-work-tree'])
    ).trim();
    if (inside !== 'true') throw new Error('not a Git worktree');
    return fact(
      'source-repo',
      'Source repository',
      'ready',
      true,
      `${resolved} is a valid Git checkout.`,
      null,
      { path: resolved },
    );
  } catch (error) {
    return fact(
      'source-repo',
      'Source repository',
      'blocked',
      true,
      `Configured checkout ${path} is unavailable: ${errorMessage(error)}`,
      'Repair the repo path with `neondeck repo add` or the typed repo config action.',
      { path },
    );
  }
}

async function identityFact(
  repoPath: string,
  mode: AutopilotMode,
  env: NodeJS.ProcessEnv,
  runGit: (cwd: string, args: string[]) => Promise<string>,
) {
  const required =
    mode === 'autofix-with-approval' || mode === 'autofix-push-when-safe';
  const [configuredName, configuredEmail] = await Promise.all([
    runGit(repoPath, ['config', '--get', 'user.name']).catch(() => ''),
    runGit(repoPath, ['config', '--get', 'user.email']).catch(() => ''),
  ]);
  const authorName = env.GIT_AUTHOR_NAME?.trim() || configuredName.trim();
  const authorEmail = env.GIT_AUTHOR_EMAIL?.trim() || configuredEmail.trim();
  const committerName = env.GIT_COMMITTER_NAME?.trim() || configuredName.trim();
  const committerEmail =
    env.GIT_COMMITTER_EMAIL?.trim() || configuredEmail.trim();
  if (authorName && authorEmail && committerName && committerEmail) {
    return fact(
      'identity',
      'Commit identity',
      'ready',
      required,
      `Unattended commits have complete author and committer identities.`,
      null,
      {
        author: { name: authorName, email: authorEmail },
        committer: { name: committerName, email: committerEmail },
      },
    );
  }
  const missing = [
    !authorName && 'author name',
    !authorEmail && 'author email',
    !committerName && 'committer name',
    !committerEmail && 'committer email',
  ].filter(Boolean);
  return fact(
    'identity',
    'Commit identity',
    'blocked',
    required,
    `Commit identity is incomplete (${missing.join(', ')} missing).`,
    'Configure repo user.name/user.email or both GIT_AUTHOR_* and GIT_COMMITTER_* overrides.',
  );
}

function branchPermissionFactsKnown(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  return (
    typeof permissions.baseRepoPush === 'boolean' &&
    typeof permissions.headRepoPush === 'boolean' &&
    typeof permissions.canLikelyPush === 'boolean'
  );
}

function checkCommandFact(
  repo: RepoConfig,
  appConfig: AppConfig,
  mode: AutopilotMode,
) {
  const required =
    mode === 'autofix-with-approval' || mode === 'autofix-push-when-safe';
  const commands = readinessRequiredChecks(repo, appConfig);
  if (commands.length === 0) {
    return fact(
      'check-commands',
      'Unattended check commands',
      required ? 'blocked' : 'not-required',
      required,
      required
        ? 'No required checks are configured for this push-capable mode.'
        : 'This mode does not require unattended verification commands.',
      required
        ? 'Configure guardrails.requiredChecks and preapprove each exact command for unattended execution.'
        : null,
      { commands: [] },
    );
  }
  const policy = executionPolicyFromConfig(appConfig);
  const checks = commands.map((command) =>
    evaluateExecutionPolicy(
      {
        command,
        backend: policy.defaultBackend,
        context: 'unattended',
      },
      policy,
    ),
  );
  const blocked = checks.filter((check) => check.decision !== 'allow');
  return fact(
    'check-commands',
    'Unattended check commands',
    blocked.length > 0 ? 'blocked' : 'ready',
    required,
    blocked.length > 0
      ? `${blocked.length}/${commands.length} required check command${commands.length === 1 ? '' : 's'} are not preapproved for unattended execution.`
      : `${commands.length} required check command${commands.length === 1 ? '' : 's'} are configured and preapproved.`,
    blocked.length > 0
      ? 'Add exact commands to execution.preapprovedCommands or reduce requiredChecks deliberately.'
      : null,
    {
      backend: policy.defaultBackend,
      commands: checks.map((check) => ({
        command: check.command,
        decision: check.decision,
        reason: check.reason,
      })),
    },
  );
}

async function ghFact(
  env: NodeJS.ProcessEnv,
  remoteChecks: boolean,
  runCommand: AutopilotReadinessDependencies['runCommand'],
) {
  if (!remoteChecks) {
    return notCheckedFact(
      'gh',
      'GitHub CLI',
      false,
      'gh availability/authentication was not probed in this summary.',
      'Run target-specific doctor readiness to inspect gh separately from API credentials.',
    );
  }
  const runner = runCommand ?? defaultCommandRunner;
  try {
    const version = await runner('gh', ['--version'], {
      env: { ...env, GH_PROMPT_DISABLED: '1' },
      timeoutMs: readinessCommandTimeoutMs,
    });
    try {
      await runner('gh', ['auth', 'status', '--hostname', 'github.com'], {
        env: { ...env, GH_PROMPT_DISABLED: '1' },
        timeoutMs: readinessCommandTimeoutMs,
      });
      return fact(
        'gh',
        'GitHub CLI',
        'ready',
        false,
        'gh is installed and authenticated; GitHub API and git credentials are still evaluated separately.',
        null,
        { version: version.stdout.split(/\r?\n/)[0] ?? '' },
      );
    } catch (error) {
      return fact(
        'gh',
        'GitHub CLI',
        'warning',
        false,
        `gh is installed but not authenticated: ${errorMessage(error)}`,
        'Run `gh auth login`; run `gh auth setup-git` only if Git also needs credential-helper setup.',
      );
    }
  } catch (error) {
    return fact(
      'gh',
      'GitHub CLI',
      'warning',
      false,
      `gh is unavailable: ${errorMessage(error)}`,
      'Install gh if mediated gh commands are desired; token-backed API readiness is independent.',
    );
  }
}

async function githubMetadata(
  token: string,
  owner: string,
  repo: string,
  fetcher: typeof githubFetch = githubFetch,
) {
  const response = await fetcher(
    token,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  const parsed = v.safeParse(
    githubRepositoryMetadataSchema,
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error(
      'GitHub returned malformed repository permission metadata.',
    );
  }
  return {
    scopes: (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    private: parsed.output.private,
    push: parsed.output.permissions.push,
    login: await githubLogin(token, fetcher),
  };
}

async function githubLogin(token: string, fetcher: typeof githubFetch) {
  const response = await fetcher(token, 'https://api.github.com/user');
  const parsed = v.safeParse(githubIdentitySchema, await response.json());
  if (!parsed.success) {
    throw new Error('GitHub returned malformed authenticated-user metadata.');
  }
  return parsed.output.login;
}

function commentFact(
  required: boolean,
  metadata: Awaited<ReturnType<typeof githubMetadata>> | null,
) {
  if (!required) {
    return fact(
      'comment',
      'PR result comment',
      'not-required',
      false,
      'This mode does not deliver an automatic PR result comment.',
      null,
    );
  }
  if (!metadata) {
    return fact(
      'comment',
      'PR result comment',
      'blocked',
      true,
      'Comment permission could not be evaluated because GitHub API metadata was unavailable.',
      'Restore GitHub API readiness and rerun this check.',
    );
  }
  const classicReady =
    metadata.scopes.includes('repo') ||
    (!metadata.private && metadata.scopes.includes('public_repo'));
  if (classicReady) {
    return fact(
      'comment',
      'PR result comment',
      'ready',
      true,
      'The classic token scope header includes repository write access for PR result comments.',
      null,
      { scopes: metadata.scopes },
    );
  }
  if (metadata.scopes.length === 0) {
    return fact(
      'comment',
      'PR result comment',
      'warning',
      true,
      'GitHub read access succeeded, but this token type does not expose non-mutating proof of pull-request comment write permission.',
      'Grant Pull requests: write (or equivalent) and verify with a disposable credentialed smoke before unattended delivery.',
      { scopes: [] },
    );
  }
  return fact(
    'comment',
    'PR result comment',
    'blocked',
    true,
    `Token scopes do not include ${metadata.private ? 'repo' : 'repo or public_repo'} comment access.`,
    'Grant pull-request comment write permission and rerun readiness.',
    { scopes: metadata.scopes },
  );
}

function readinessMode(repo: RepoConfig, appConfig: AppConfig): AutopilotMode {
  const repoAutopilot = objectValue(repo.metadata?.autopilot);
  const repoMode = repoAutopilot?.mode;
  if (isAutopilotMode(repoMode)) return repoMode;
  const appMode = appConfig.autopilot?.defaultMode ?? appConfig.autopilot?.mode;
  return isAutopilotMode(appMode) ? appMode : 'notify-only';
}

function readinessRequiredChecks(repo: RepoConfig, appConfig: AppConfig) {
  const appGuardrails = v.safeParse(repoGuardrailsSchema, appConfig.guardrails);
  const repoGuardrails = v.safeParse(
    repoGuardrailsSchema,
    objectValue(repo.metadata)?.guardrails,
  );
  return {
    ...defaultRepoGuardrails,
    ...(appGuardrails.success ? appGuardrails.output : {}),
    ...(repoGuardrails.success ? repoGuardrails.output : {}),
  }.requiredChecks;
}

function isAutopilotMode(value: unknown): value is AutopilotMode {
  return (
    value === 'notify-only' ||
    value === 'prepare-only' ||
    value === 'autofix-with-approval' ||
    value === 'autofix-push-when-safe'
  );
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modeFact(
  id: 'fetch' | 'git-push' | 'comment',
  label: string,
  required: boolean,
  prNumber: number | undefined,
  remoteChecks: boolean,
) {
  if (!required) {
    return fact(
      id,
      label,
      'not-required',
      false,
      'This fact is not required for the selected mode.',
      null,
    );
  }
  return notCheckedFact(
    id,
    label,
    true,
    !remoteChecks
      ? 'Live credential checks were skipped for this summary.'
      : prNumber
        ? 'The prerequisite GitHub PR facts were unavailable.'
        : 'Select a PR to verify the exact head and delivery target.',
    'Run `neondeck doctor --repo <id> --pr <number>`.',
  );
}

function notCheckedFact(
  id: AutopilotReadinessFactId,
  label: string,
  required: boolean,
  message: string,
  action: string,
) {
  return fact(id, label, 'not-checked', required, message, action);
}

function fact(
  id: AutopilotReadinessFactId,
  label: string,
  status: AutopilotReadinessFactStatus,
  required: boolean,
  message: string,
  action: string | null,
  details?: Record<string, unknown>,
): AutopilotReadinessFact {
  return { id, label, status, required, message, action, details };
}

function indexFacts(facts: AutopilotReadinessFact[]) {
  return Object.fromEntries(facts.map((item) => [item.id, item])) as Record<
    AutopilotReadinessFactId,
    AutopilotReadinessFact
  >;
}

async function defaultCommandRunner(
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) {
  const result = await execFileAsync(file, args, {
    env: options.env,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
