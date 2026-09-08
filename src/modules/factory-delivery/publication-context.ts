import { createHash } from 'node:crypto';
import * as v from 'valibot';
import {
  githubRepositoryIdentitySchema,
  type GitHubRepositoryIdentity,
} from '../../../shared/factory-github';
import {
  type AppConfig,
  type RepoConfig,
  type RuntimePaths,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJsonSync,
} from '../../runtime-home';
import {
  factoryPullIdentitySchema,
  resolveFactoryGitHubRepository,
} from '../github';

export class PublicationContextError extends Error {
  constructor(
    public code:
      | 'unconfigured'
      | 'credential-missing'
      | 'mapping-invalid'
      | 'metadata-unavailable',
    message: string,
  ) {
    super(message);
  }
}
export type FactoryPublicationRepo = Pick<
  RepoConfig,
  'id' | 'github' | 'defaultBranch'
>;
export type FactoryPublicationConfig = {
  repoId: string;
  repositoryId: string;
  tokenEnv: string;
};
type Config = Pick<NonNullable<AppConfig['factory']>, 'github' | 'publication'>;
export type FactoryPublicationContext = {
  connection: GitHubRepositoryIdentity;
  baseBranch: string;
  source: 'publication' | 'configured-intake';
};
const setupInputSchema = v.strictObject({
  tokenEnv: v.optional(githubRepositoryIdentitySchema.entries.tokenEnv),
});
function target(repo: FactoryPublicationRepo) {
  const parsed = v.safeParse(
    v.object({
      owner: githubRepositoryIdentitySchema.entries.owner,
      name: githubRepositoryIdentitySchema.entries.name,
    }),
    repo.github,
  );
  const branch = v.safeParse(
    factoryPullIdentitySchema.entries.base,
    repo.defaultBranch,
  );
  if (!parsed.success || !branch.success)
    throw new PublicationContextError(
      'mapping-invalid',
      'Configure a valid registered GitHub repository and default branch.',
    );
  return { ...parsed.output, baseBranch: branch.output };
}
function configured(repo: FactoryPublicationRepo, config: Config) {
  const registered = target(repo);
  const entries = (config.publication ?? []).filter(
    (entry) => entry.repoId === repo.id,
  );
  if (entries.length > 1)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication configuration is ambiguous.',
    );
  if (entries[0]) return { entry: entries[0], source: 'publication' as const };
  const intake = config.github.filter((entry) => entry.repoId === repo.id);
  if (intake.length > 1)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication configuration is ambiguous.',
    );
  if (intake[0]) {
    if (
      intake[0].owner !== registered.owner ||
      intake[0].name !== registered.name
    )
      throw new PublicationContextError(
        'mapping-invalid',
        'Publication configuration does not match the registered repository.',
      );
    return { entry: intake[0], source: 'configured-intake' as const };
  }
  return undefined;
}
function connectionFor(
  repo: FactoryPublicationRepo,
  entry: FactoryPublicationConfig,
) {
  const registered = target(repo);
  const parsed = v.safeParse(githubRepositoryIdentitySchema, {
    owner: registered.owner,
    name: registered.name,
    repositoryId: entry.repositoryId,
    tokenEnv: entry.tokenEnv,
  });
  if (!parsed.success)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication configuration is invalid.',
    );
  if (!process.env[parsed.output.tokenEnv]?.trim())
    throw new PublicationContextError(
      'credential-missing',
      `Configure the ${parsed.output.tokenEnv} credential reference for publication.`,
    );
  return parsed.output;
}
/** Synchronous authority snapshot: no intake enablement and no remote effects. */
export function resolveFactoryPublicationContext(
  repo: FactoryPublicationRepo,
  config: Config,
): FactoryPublicationContext {
  const selected = configured(repo, config);
  if (!selected)
    throw new PublicationContextError(
      'unconfigured',
      'Configure GitHub publication for this repository. Intake and webhooks are not required.',
    );
  return {
    connection: connectionFor(repo, selected.entry),
    baseBranch: target(repo).baseBranch,
    source: selected.source,
  };
}
/** Returns a public-safe config entry; caller owns stale-preview checks and typed persistence. */
export async function prepareFactoryPublicationContext(
  repo: FactoryPublicationRepo,
  config: Config,
  options: { tokenEnv?: string; signal?: AbortSignal; fresh?: boolean } = {},
): Promise<{
  connection: GitHubRepositoryIdentity;
  baseBranch: string;
  publication: FactoryPublicationConfig;
}> {
  const parsed = v.safeParse(setupInputSchema, { tokenEnv: options.tokenEnv });
  if (!parsed.success)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication credential reference is invalid.',
    );
  const selected = configured(repo, config);
  const registered = target(repo);
  const tokenEnv =
    parsed.output.tokenEnv ?? selected?.entry.tokenEnv ?? 'GITHUB_TOKEN';
  if (!process.env[tokenEnv]?.trim())
    throw new PublicationContextError(
      'credential-missing',
      `Configure the ${tokenEnv} credential reference for publication.`,
    );
  // Validate existing IDs and references before contacting GitHub; never repair a conflicting mapping silently.
  if (selected) connectionFor(repo, { ...selected.entry, tokenEnv });
  let connection: GitHubRepositoryIdentity;
  try {
    connection = await resolveFactoryGitHubRepository(
      { owner: registered.owner, name: registered.name, tokenEnv },
      options,
    );
  } catch {
    throw new PublicationContextError(
      'metadata-unavailable',
      'GitHub publication setup could not verify the registered repository and credential.',
    );
  }
  if (selected && selected.entry.repositoryId !== connection.repositoryId)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication repository identity changed.',
    );
  return {
    connection,
    baseBranch: registered.baseBranch,
    publication: {
      repoId: repo.id,
      repositoryId: connection.repositoryId,
      tokenEnv,
    },
  };
}
function snapshot(repoId: string, paths: RuntimePaths) {
  const repos = readRuntimeJsonSync(
    paths.repos,
    parseRepoRegistry,
  ).repos.filter((repo) => repo.id === repoId);
  if (repos.length !== 1)
    throw new PublicationContextError(
      'mapping-invalid',
      'Registered publication repository was not found.',
    );
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  return { repo: repos[0]!, config: config.factory ?? { github: [] } };
}
export function resolvePublicationContext(repoId: string, paths: RuntimePaths) {
  const { repo, config } = snapshot(repoId, paths);
  const resolved = resolveFactoryPublicationContext(repo, config);
  const target = {
    owner: resolved.connection.owner,
    name: resolved.connection.name,
    baseBranch: resolved.baseBranch,
  };
  const configFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        repoId,
        connection: resolved.connection,
        target,
        source: resolved.source,
      }),
    )
    .digest('hex');
  return { connection: resolved.connection, target, configFingerprint };
}
export async function prepareFactoryPublication(
  repoId: string,
  input: { tokenEnv?: string },
  paths: RuntimePaths,
): Promise<FactoryPublicationConfig> {
  const parsed = v.safeParse(setupInputSchema, input);
  if (!parsed.success)
    throw new PublicationContextError(
      'mapping-invalid',
      'Publication setup input is invalid.',
    );
  const { repo, config } = snapshot(repoId, paths);
  return (
    await prepareFactoryPublicationContext(repo, config, {
      ...parsed.output,
      fresh: true,
    })
  ).publication;
}
