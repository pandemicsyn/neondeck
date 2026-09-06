import * as v from 'valibot';
import {
  githubConnectionSchema,
  type GitHubConnection,
} from '../../../shared/factory-github';
import { githubFetch } from './client';

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const id = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const sha = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/));
const ref = v.pipe(
  text,
  v.check(
    (value) =>
      !/[\s~^:?*[\\]/.test(value) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      value !== '@' &&
      value
        .split('/')
        .every(
          (part) =>
            !!part &&
            !part.startsWith('.') &&
            !part.endsWith('.') &&
            !part.endsWith('.lock'),
        ),
    'Expected a branch ref.',
  ),
);
const timestamp = v.pipe(v.string(), v.isoTimestamp());
export const factoryPullMarkerSchema = v.pipe(
  v.string(),
  v.regex(/^<!-- neon-factory-pr:[A-Za-z0-9_-]{1,128} -->$/),
);
/** Slice 3 is deliberately same-repository only. Persist this identity before POST. */
export const factoryPullIdentitySchema = v.strictObject({
  head: ref,
  base: ref,
  marker: factoryPullMarkerSchema,
});
export type FactoryPullIdentity = v.InferOutput<
  typeof factoryPullIdentitySchema
>;
export const factoryPullCreateSchema = v.strictObject({
  ...factoryPullIdentitySchema.entries,
  title: v.pipe(
    text,
    v.check((value) => value.trim().length > 0),
  ),
  body: v.pipe(v.string(), v.maxLength(65000)),
});
const repository = v.object({
  id,
  name: text,
  owner: v.object({ login: text }),
});
const branch = v.object({ ref, sha, repo: repository });
// GitHub response objects intentionally allow unrelated API fields. Every fact
// consumed here is required and validated; absent draft/merge facts never default.
export const factoryPullSchema = v.object({
  id,
  number: id,
  html_url: v.pipe(v.string(), v.url()),
  title: text,
  body: v.nullable(v.pipe(v.string(), v.maxLength(65536))),
  state: v.picklist(['open', 'closed']),
  draft: v.boolean(),
  head: branch,
  base: branch,
  user: v.object({ id, login: text }),
  merged_at: v.nullable(timestamp),
  merge_commit_sha: v.nullable(sha),
  updated_at: timestamp,
});
export const factoryPullDetailSchema = v.object({
  ...factoryPullSchema.entries,
  merged: v.boolean(),
  mergeable: v.nullable(v.boolean()),
  mergeable_state: text,
});
export type FactoryPull = v.InferOutput<typeof factoryPullSchema>;
export type FactoryPullReadOptions = {
  fresh?: boolean;
  signal?: AbortSignal;
  maxPages?: number;
};
export type FactoryPullLookup =
  | { status: 'found'; pull: FactoryPull; pages: number }
  | { status: 'absent'; pages: number }
  | { status: 'incomplete'; candidate: FactoryPull | null; pages: number };

function context(connection: GitHubConnection) {
  const value = v.parse(githubConnectionSchema, connection);
  const token = process.env[value.tokenEnv];
  if (!token) throw new Error('Factory GitHub token is not configured.');
  return {
    token,
    url: `https://api.github.com/repos/${encodeURIComponent(value.owner)}/${encodeURIComponent(value.name)}`,
  };
}
function readOptions(options: FactoryPullReadOptions): RequestInit {
  // Every managed GET contacts GitHub. Fresh authority reads must not join a
  // request begun earlier, but can still use credential-scoped ETags and 304s.
  // A signal disables the client's in-flight sharing without disabling validators.
  return {
    signal:
      options.signal ??
      (options.fresh ? new AbortController().signal : undefined),
    redirect: 'error',
    ...(options.fresh ? { cache: 'no-cache' } : {}),
  };
}
async function json(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned no body.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024)
        throw new Error('Factory GitHub response exceeds 2 MiB.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
function matchesRepo(pull: FactoryPull, connection: GitHubConnection) {
  return [pull.head.repo, pull.base.repo].every(
    (repo) =>
      String(repo.id) === connection.repositoryId &&
      repo.name === connection.name &&
      repo.owner.login === connection.owner,
  );
}
function assertIdentity(
  pull: FactoryPull,
  connection: GitHubConnection,
  identity: FactoryPullIdentity,
) {
  const markers = pull.body?.match(/<!--\s*neon-factory-pr:[\s\S]*?-->/g) ?? [];
  if (
    !matchesRepo(pull, connection) ||
    pull.head.ref !== identity.head ||
    pull.base.ref !== identity.base ||
    markers.length !== 1 ||
    markers[0] !== identity.marker ||
    pull.html_url !==
      `https://github.com/${connection.owner}/${connection.name}/pull/${pull.number}`
  ) {
    throw new Error('Factory pull request identity conflict.');
  }
  if (pull.merged_at !== null && pull.state !== 'closed')
    throw new Error('Conflicting factory pull merge facts.');
}
/** Never follow server-provided URLs (including a hostile Link) with credentials. */
function hasNext(response: Response) {
  const link = response.headers.get('link');
  if (!link) return false;
  let next = false;
  for (const part of link.split(',')) {
    const match = part.match(/^\s*<[^>]+>;\s*rel="([a-z ]+)"\s*$/);
    if (!match) throw new Error('Malformed GitHub pagination Link.');
    if (match[1]?.split(' ').includes('next')) next = true;
  }
  return next;
}
function maxPages(options: FactoryPullReadOptions) {
  return v.parse(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)),
    options.maxPages ?? 3,
  );
}
/** Searches all states, so a closed/merged receipt cannot trigger another create.
 * A bounded scan is not an atomic uniqueness guarantee. The effects owner must
 * serialize publication and reconcile uncertain POSTs with fresh:true; never
 * interpret absent alone as permission to retry an uncertain write.
 */
export async function lookupFactoryGitHubPull(
  connection: GitHubConnection,
  input: FactoryPullIdentity,
  options: FactoryPullReadOptions = {},
): Promise<FactoryPullLookup> {
  const identity = v.parse(factoryPullIdentitySchema, input);
  const { token, url } = context(connection);
  const limit = maxPages(options);
  let candidate: FactoryPull | null = null;
  const seen = new Set<number>();
  for (let page = 1; page <= limit; page++) {
    const query = new URLSearchParams({
      state: 'all',
      head: `${connection.owner}:${identity.head}`,
      base: identity.base,
      sort: 'created',
      direction: 'asc',
      per_page: '25',
      page: String(page),
    });
    const response = await githubFetch(
      token,
      `${url}/pulls?${query}`,
      readOptions(options),
    );
    const items = v.parse(
      v.pipe(v.array(factoryPullSchema), v.maxLength(25)),
      await json(response),
    );
    for (const pull of items) {
      assertIdentity(pull, connection, identity);
      if (seen.has(pull.id) || candidate)
        throw new Error('Duplicate factory pull request results.');
      seen.add(pull.id);
      candidate = pull;
    }
    if (!hasNext(response))
      return candidate
        ? { status: 'found', pull: candidate, pages: page }
        : { status: 'absent', pages: page };
  }
  return { status: 'incomplete', candidate, pages: limit };
}
/** Exactly one POST. Failures (including malformed success) stay uncertain for
 * the caller to reconcile. This function does not perform effects orchestration.
 */
export async function createFactoryGitHubDraftPull(
  connection: GitHubConnection,
  input: v.InferOutput<typeof factoryPullCreateSchema>,
  signal?: AbortSignal,
): Promise<FactoryPull> {
  const value = v.parse(factoryPullCreateSchema, input);
  if (value.body.includes('neon-factory-pr:'))
    throw new Error('PR body already contains a factory marker.');
  const { token, url } = context(connection);
  const response = await githubFetch(token, `${url}/pulls`, {
    method: 'POST',
    redirect: 'error',
    signal,
    body: JSON.stringify({
      title: value.title,
      body: `${value.body}\n\n${value.marker}`,
      head: value.head,
      base: value.base,
      draft: true,
      maintainer_can_modify: false,
    }),
  });
  const pull = v.parse(factoryPullSchema, await json(response));
  assertIdentity(pull, connection, value);
  if (
    response.status !== 201 ||
    !pull.draft ||
    pull.state !== 'open' ||
    pull.merged_at !== null
  )
    throw new Error(
      'GitHub did not confirm creation of an open draft pull request.',
    );
  return pull;
}
export async function readFactoryGitHubPull(
  connection: GitHubConnection,
  number: number,
  input: FactoryPullIdentity,
  options: FactoryPullReadOptions = {},
) {
  const identity = v.parse(factoryPullIdentitySchema, input);
  v.parse(id, number);
  const { token, url } = context(connection);
  const response = await githubFetch(
    token,
    `${url}/pulls/${number}`,
    readOptions(options),
  );
  const pull = v.parse(factoryPullDetailSchema, await json(response));
  assertIdentity(pull, connection, identity);
  if (pull.number !== number || pull.merged !== (pull.merged_at !== null))
    throw new Error('Conflicting factory pull detail facts.');
  return pull;
}

export const factoryPullCheckSchema = v.object({
  id,
  name: text,
  head_sha: sha,
  status: v.picklist([
    'queued',
    'in_progress',
    'completed',
    'waiting',
    'requested',
    'pending',
  ]),
  conclusion: v.nullable(
    v.picklist([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
    ]),
  ),
});
export const factoryPullReviewSchema = v.object({
  id,
  user: v.nullable(v.object({ id, login: text })),
  commit_id: sha,
  state: v.picklist([
    'APPROVED',
    'CHANGES_REQUESTED',
    'COMMENTED',
    'DISMISSED',
    'PENDING',
  ]),
  submitted_at: v.optional(v.nullable(timestamp)),
  body: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(65536)))),
});
export const factoryPullStatusSchema = v.object({
  id,
  context: text,
  state: v.picklist(['error', 'failure', 'pending', 'success']),
  updated_at: timestamp,
});
export const factoryPullCommentSchema = v.object({
  id,
  body: v.pipe(v.string(), v.maxLength(65536)),
  user: v.nullable(v.object({ id, login: text })),
  created_at: timestamp,
  updated_at: timestamp,
});
export const factoryPullInlineCommentSchema = v.object({
  ...factoryPullCommentSchema.entries,
  pull_request_review_id: id,
  commit_id: sha,
  original_commit_id: sha,
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  line: v.nullable(id),
  original_line: v.nullable(id),
  side: v.picklist(['LEFT', 'RIGHT']),
  in_reply_to_id: v.optional(id),
});
/** Raw facts, not a policy verdict: empty CI is not success; reviews may target
 * older commits. Each collection explicitly reports whether its scan completed.
 */
export async function observeFactoryGitHubPull(
  connection: GitHubConnection,
  number: number,
  identity: FactoryPullIdentity,
  options: FactoryPullReadOptions = {},
) {
  const pull = await readFactoryGitHubPull(
    connection,
    number,
    identity,
    options,
  );
  const { token, url } = context(connection);
  const limit = maxPages(options);
  async function collect<T>(
    path: string,
    parse: (body: unknown) => { items: T[]; total?: number },
    key: (item: T) => number,
  ) {
    const items: T[] = [];
    const seen = new Set<number>();
    let expectedTotal: number | undefined;
    for (let page = 1; page <= limit; page++) {
      const response = await githubFetch(
        token,
        `${url}/${path}${path.includes('?') ? '&' : '?'}per_page=25&page=${page}`,
        readOptions(options),
      );
      const data = parse(await json(response));
      if (data.total !== undefined) {
        if (expectedTotal !== undefined && expectedTotal !== data.total)
          throw new Error('GitHub listing changed during observation.');
        expectedTotal = data.total;
      }
      for (const item of data.items) {
        if (seen.has(key(item)))
          throw new Error('Duplicate GitHub observation result.');
        seen.add(key(item));
        items.push(item);
      }
      if (!hasNext(response))
        return {
          items,
          complete:
            expectedTotal === undefined || expectedTotal === items.length,
        };
    }
    return { items, complete: false };
  }
  const checks = await collect(
    `commits/${pull.head.sha}/check-runs?filter=latest`,
    (body) => {
      const data = v.parse(
        v.object({
          total_count: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
          check_runs: v.pipe(v.array(factoryPullCheckSchema), v.maxLength(25)),
        }),
        body,
      );
      if (
        data.check_runs.some(
          (check) =>
            check.head_sha !== pull.head.sha ||
            (check.status !== 'completed' && check.conclusion !== null),
        )
      )
        throw new Error('Conflicting GitHub check facts.');
      return { items: data.check_runs, total: data.total_count };
    },
    (item) => item.id,
  );
  const statuses = await collect(
    `commits/${pull.head.sha}/statuses`,
    (body) => ({
      items: v.parse(
        v.pipe(v.array(factoryPullStatusSchema), v.maxLength(25)),
        body,
      ),
    }),
    (item) => item.id,
  );
  const reviews = await collect(
    `pulls/${number}/reviews`,
    (body) => ({
      items: v.parse(
        v.pipe(v.array(factoryPullReviewSchema), v.maxLength(25)),
        body,
      ),
    }),
    (item) => item.id,
  );
  const issueComments = await collect(
    `issues/${number}/comments`,
    (body) => ({
      items: v.parse(
        v.pipe(v.array(factoryPullCommentSchema), v.maxLength(25)),
        body,
      ),
    }),
    (item) => item.id,
  );
  const inlineComments = await collect(
    `pulls/${number}/comments`,
    (body) => ({
      items: v.parse(
        v.pipe(v.array(factoryPullInlineCommentSchema), v.maxLength(25)),
        body,
      ),
    }),
    (item) => item.id,
  );
  const after = await readFactoryGitHubPull(connection, number, identity, {
    ...options,
    fresh: true,
  });
  if (
    after.head.sha !== pull.head.sha ||
    after.base.sha !== pull.base.sha ||
    after.updated_at !== pull.updated_at ||
    after.state !== pull.state ||
    after.draft !== pull.draft ||
    after.merged !== pull.merged
  )
    throw new Error('Factory pull changed during observation.');
  return {
    pull: after,
    checks,
    statuses,
    reviews,
    issueComments,
    inlineComments,
    complete: [checks, statuses, reviews, issueComments, inlineComments].every(
      (collection) => collection.complete,
    ),
  };
}
