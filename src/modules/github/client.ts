import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { githubGraphqlBaseResponseSchema } from './schemas';
import { GitHubApiError, githubErrorMessage, isRequestTimeout } from './errors';
import { githubRetryAt } from './retry';

const githubRequestTimeoutMs = 15_000;
const githubMaxConcurrentRequests = 8;
const githubValidatorCacheMaxEntries = 256;
const githubValidatorCacheMaxBytes = 32 * 1024 * 1024;
const githubValidatorMaxBodyBytes = 2 * 1024 * 1024;
const githubLoginCacheTtlMs = 60 * 60 * 1000;

type CachedGitHubResponse = {
  tokenFingerprint: string;
  body: ArrayBuffer;
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

const githubValidatorCache = new Map<string, CachedGitHubResponse>();
const githubGetRequestsInFlight = new Map<string, Promise<Response>>();
const githubGraphqlQueriesInFlight = new Map<string, Promise<unknown>>();
const githubLoginCache = new Map<
  string,
  { expiresAt: number | null; value: Promise<string> }
>();
// A process-wide epoch avoids an unbounded map of historical token identities.
// Writes conservatively separate all in-flight reads; retained bodies are evicted
// only for the affected token.
let githubReadEpoch = 0;
const githubRequestWaiters: Array<{
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}> = [];
let githubValidatorCacheBytes = 0;
let githubActiveRequests = 0;

export async function fetchGitHubLogin(
  token: string,
  options: { revalidate?: boolean } = {},
) {
  const key = githubTokenFingerprint(token);
  const cached = githubLoginCache.get(key);
  if (
    cached &&
    (cached.expiresAt === null ||
      (!options.revalidate && cached.expiresAt > Date.now()))
  ) {
    githubLoginCache.delete(key);
    githubLoginCache.set(key, cached);
    return cached.value;
  }
  if (cached) githubLoginCache.delete(key);

  const entry: { expiresAt: number | null; value: Promise<string> } = {
    expiresAt: null,
    value: Promise.resolve(''),
  };
  entry.value = fetchGitHubLoginUncached(token)
    .then((login) => {
      entry.expiresAt = Date.now() + githubLoginCacheTtlMs;
      return login;
    })
    .catch((error) => {
      if (githubLoginCache.get(key) === entry) githubLoginCache.delete(key);
      throw error;
    });
  githubLoginCache.set(key, entry);
  while (githubLoginCache.size > 8) {
    const oldestKey = githubLoginCache.keys().next().value;
    if (oldestKey === undefined) break;
    githubLoginCache.delete(oldestKey);
  }
  return entry.value;
}

async function fetchGitHubLoginUncached(token: string) {
  const response = await githubFetch(token, 'https://api.github.com/user');
  const data = v.parse(v.object({ login: v.string() }), await response.json());
  if (!data.login) throw new Error('GitHub API did not return a login');
  return data.login;
}

export async function githubGraphqlFetch(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
) {
  const mutation = isGraphqlMutation(query);
  if (options.signal || mutation) {
    return executeGitHubGraphqlFetch(
      token,
      query,
      variables,
      options,
      mutation,
    );
  }

  const key = createHash('sha256')
    .update(githubTokenFingerprint(token))
    .update('\0')
    .update(String(githubReadGeneration()))
    .update('\0')
    .update(query)
    .update('\0')
    .update(JSON.stringify(variables))
    .digest('base64url');
  const existing = githubGraphqlQueriesInFlight.get(key);
  if (existing) return existing;
  const request = executeGitHubGraphqlFetch(
    token,
    query,
    variables,
    options,
    false,
  ).finally(() => {
    if (githubGraphqlQueriesInFlight.get(key) === request) {
      githubGraphqlQueriesInFlight.delete(key);
    }
  });
  githubGraphqlQueriesInFlight.set(key, request);
  return request;
}

async function executeGitHubGraphqlFetch(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  options: { signal?: AbortSignal },
  mutation: boolean,
) {
  const response = await githubFetch(
    token,
    'https://api.github.com/graphql',
    {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      signal: options.signal,
    },
    { write: mutation },
  );
  const data = await response.json();
  const parsed = v.parse(githubGraphqlBaseResponseSchema, data);
  if (parsed.errors?.length) {
    throw new Error(
      `GitHub GraphQL request failed: ${parsed.errors.map((item) => item.message).join('; ')}`,
    );
  }

  return data;
}

export async function githubFetch(
  token: string,
  url: string,
  init: RequestInit = {},
  behavior: { write?: boolean } = {},
) {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = githubRequestHeaders(token, init);
  if (method !== 'GET' || init.body) {
    const write = behavior.write ?? method !== 'GET';
    if (write) advanceGitHubReadGeneration(token);
    try {
      return await executeGitHubRequest(url, { ...init, headers });
    } finally {
      // A timeout or failed response may follow a successful remote mutation.
      // Also fences reads started while the write was in flight.
      if (write) advanceGitHubReadGeneration(token);
    }
  }

  const generation = githubReadGeneration();
  const useValidators =
    init.cache !== 'no-store' && shouldUseManagedValidators(init.headers);
  const validatorCacheKey = useValidators
    ? githubValidatorCacheKey(token, url, headers)
    : undefined;
  const cached = validatorCacheKey
    ? readCachedGitHubResponse(validatorCacheKey)
    : undefined;
  if (cached) {
    const cachedHeaders = new Headers(cached.headers);
    const etag = cachedHeaders.get('etag');
    const lastModified = cachedHeaders.get('last-modified');
    if (etag && !hasHeader(headers, 'if-none-match')) {
      setHeader(headers, 'If-None-Match', etag);
    } else if (lastModified && !hasHeader(headers, 'if-modified-since')) {
      setHeader(headers, 'If-Modified-Since', lastModified);
    }
  }

  // Most GitHub reads fan out from a small number of local actions. Sharing an
  // identical request prevents adjacent dashboard, watcher, and agent reads
  // from spending quota (and secondary-rate budget) on the same work.
  if (
    !init.signal &&
    init.cache !== 'no-store' &&
    !hasNoStore(new Headers(init.headers))
  ) {
    const requestKey = githubGetRequestKey(token, url, headers, generation);
    const existing = githubGetRequestsInFlight.get(requestKey);
    if (existing) return (await existing).clone();

    const request = executeConditionalGitHubGet(
      token,
      url,
      { ...init, headers },
      validatorCacheKey,
      cached,
      generation,
    ).finally(() => {
      if (githubGetRequestsInFlight.get(requestKey) === request) {
        githubGetRequestsInFlight.delete(requestKey);
      }
    });
    githubGetRequestsInFlight.set(requestKey, request);
    return request;
  }

  return executeConditionalGitHubGet(
    token,
    url,
    { ...init, headers },
    validatorCacheKey,
    cached,
    generation,
  );
}

async function executeConditionalGitHubGet(
  token: string,
  url: string,
  init: RequestInit,
  validatorCacheKey: string | undefined,
  cached: CachedGitHubResponse | undefined,
  generation: number,
) {
  const response = await executeGitHubRequest(url, init, cached);
  if (response.status === 304 && cached) {
    if (githubReadGeneration() !== generation) {
      throw new Error(
        'GitHub read invalidated during conditional revalidation; retry.',
      );
    }
    const headers = new Headers(cached.headers);
    for (const [name, value] of response.headers) headers.set(name, value);
    const refreshed = { ...cached, headers: [...headers.entries()] };
    if (validatorCacheKey) {
      if (hasNoStore(headers) || !boundedCacheHeaders(headers))
        deleteCachedGitHubResponse(validatorCacheKey);
      else storeCachedGitHubResponse(validatorCacheKey, refreshed);
    }
    return new Response(cached.body.slice(0), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  // A replacement response must not leave a superseded validator behind,
  // including no-store, partial, invalid JSON, or oversized responses.
  if (validatorCacheKey && githubReadGeneration() === generation) {
    deleteCachedGitHubResponse(validatorCacheKey);
  }
  if (
    validatorCacheKey &&
    githubReadGeneration() === generation &&
    response.ok &&
    isValidatorCacheable(response)
  ) {
    const body = await readBoundedGitHubResponseBody(
      response,
      githubValidatorMaxBodyBytes,
    );
    if (body && githubReadGeneration() === generation && isJsonBody(body)) {
      storeCachedGitHubResponse(validatorCacheKey, {
        tokenFingerprint: githubTokenFingerprint(token),
        body,
        headers: [...response.headers.entries()],
        status: response.status,
        statusText: response.statusText,
      });
    }
  }
  return response;
}

async function executeGitHubRequest(
  url: string,
  init: RequestInit,
  cached?: CachedGitHubResponse,
) {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(githubRequestTimeoutMs);
  const requestSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  let acquiredSlot = false;
  try {
    await acquireGitHubRequestSlot(requestSignal);
    acquiredSlot = true;
    response = await fetch(url, {
      ...init,
      signal: requestSignal,
    });
  } catch (error) {
    if (acquiredSlot) releaseGitHubRequestSlot();
    if (
      timeoutSignal.aborted &&
      !init.signal?.aborted &&
      isRequestTimeout(error)
    ) {
      throw new Error(
        `GitHub request timed out after ${Math.round(githubRequestTimeoutMs / 1000)}s`,
      );
    }
    throw error;
  }

  const managedResponse = holdGitHubRequestSlot(response);
  if (managedResponse.status === 304 && cached) return managedResponse;
  if (!managedResponse.ok) {
    const data = await readGitHubErrorData(managedResponse);
    await discardGitHubResponseBody(managedResponse);
    throw new GitHubApiError(
      managedResponse.status,
      data,
      githubErrorMessage(managedResponse, data),
      {
        rateLimited:
          managedResponse.status === 429 ||
          (managedResponse.status === 403 &&
            (managedResponse.headers.get('x-ratelimit-remaining') === '0' ||
              managedResponse.headers.has('retry-after'))),
        retryAt: githubRetryAt(managedResponse.headers),
      },
    );
  }

  return managedResponse;
}

function githubRequestHeaders(token: string, init: RequestInit) {
  const requestedHeaders = new Headers(init.headers);
  if (requestedHeaders.has('authorization')) {
    throw new Error(
      'GitHub Authorization must be supplied through the token argument.',
    );
  }
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'neondeck',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (init.body) headers['Content-Type'] = 'application/json';
  for (const [name, value] of requestedHeaders) {
    setHeader(headers, name, value);
  }
  return headers;
}

function isGraphqlMutation(query: string) {
  return /^\s*(?:#[^\n]*(?:\n|$)\s*)*mutation\b/.test(query);
}

function shouldUseManagedValidators(headers: HeadersInit | undefined) {
  const requested = new Headers(headers);
  return (
    !hasNoStore(requested) &&
    !requested.has('range') &&
    !requested.has('if-none-match') &&
    !requested.has('if-modified-since')
  );
}

function githubValidatorCacheKey(
  token: string,
  url: string,
  headers: HeadersInit,
) {
  const representationHeaders = canonicalHeaders(headers, [
    'authorization',
    'if-modified-since',
    'if-none-match',
    'user-agent',
  ]);
  return createHash('sha256')
    .update(githubTokenFingerprint(token))
    .update('\0')
    .update(url)
    .update('\0')
    .update(representationHeaders)
    .digest('base64url');
}

function githubGetRequestKey(
  token: string,
  url: string,
  headers: HeadersInit,
  generation: number,
) {
  return createHash('sha256')
    .update(githubTokenFingerprint(token))
    .update('\0')
    .update(String(generation))
    .update('\0')
    .update(url)
    .update('\0')
    .update(canonicalHeaders(headers))
    .digest('base64url');
}

function canonicalHeaders(headers: HeadersInit, excluded: string[] = []) {
  const excludedNames = new Set(excluded.map((name) => name.toLowerCase()));
  return JSON.stringify(
    [...new Headers(headers).entries()]
      .filter(([name]) => !excludedNames.has(name.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function hasHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
}

function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
) {
  const existing = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  headers[existing ?? name] = value;
}

export function githubTokenFingerprint(token: string) {
  return createHash('sha256').update(token).digest('base64url');
}

function githubReadGeneration() {
  return githubReadEpoch;
}

function advanceGitHubReadGeneration(token: string) {
  githubReadEpoch += 1;
  const fingerprint = githubTokenFingerprint(token);
  githubLoginCache.delete(fingerprint);
  for (const [key, entry] of githubValidatorCache) {
    if (entry.tokenFingerprint === fingerprint) deleteCachedGitHubResponse(key);
  }
}

function deleteCachedGitHubResponse(key: string) {
  const cached = githubValidatorCache.get(key);
  if (cached) githubValidatorCacheBytes -= cached.body.byteLength;
  githubValidatorCache.delete(key);
}

function hasNoStore(headers: Headers) {
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(
    headers.get('cache-control') ?? '',
  );
}

function boundedCacheHeaders(headers: Headers) {
  // Bound metadata as well as the separately bounded body (at most 256 entries).
  let bytes = 0;
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 16 * 1024) return false;
  }
  return true;
}

function isJsonBody(body: ArrayBuffer) {
  try {
    JSON.parse(new TextDecoder().decode(body));
    return true;
  } catch {
    return false;
  }
}

function readCachedGitHubResponse(key: string) {
  const cached = githubValidatorCache.get(key);
  if (!cached) return undefined;
  githubValidatorCache.delete(key);
  githubValidatorCache.set(key, cached);
  return cached;
}

function isValidatorCacheable(response: Response) {
  if (
    response.status !== 200 ||
    hasNoStore(response.headers) ||
    !boundedCacheHeaders(response.headers)
  )
    return false;
  if (!response.headers.has('etag') && !response.headers.has('last-modified')) {
    return false;
  }
  const declaredContentLength = response.headers.get('content-length');
  const contentLength =
    declaredContentLength === null ? undefined : Number(declaredContentLength);
  if (
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > githubValidatorMaxBodyBytes
  ) {
    return false;
  }
  return /(^|[+/])json\b/i.test(response.headers.get('content-type') ?? '');
}

async function readBoundedGitHubResponseBody(
  response: Response,
  maxBytes: number,
) {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body.buffer;
      }
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return undefined;
  }
}

function storeCachedGitHubResponse(key: string, value: CachedGitHubResponse) {
  const existing = githubValidatorCache.get(key);
  if (existing) githubValidatorCacheBytes -= existing.body.byteLength;
  githubValidatorCache.delete(key);
  githubValidatorCache.set(key, value);
  githubValidatorCacheBytes += value.body.byteLength;

  while (
    githubValidatorCache.size > githubValidatorCacheMaxEntries ||
    githubValidatorCacheBytes > githubValidatorCacheMaxBytes
  ) {
    const oldestKey = githubValidatorCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = githubValidatorCache.get(oldestKey);
    if (oldest) githubValidatorCacheBytes -= oldest.body.byteLength;
    githubValidatorCache.delete(oldestKey);
  }
}

function holdGitHubRequestSlot(response: Response) {
  if (!response.body) {
    releaseGitHubRequestSlot();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseGitHubRequestSlot();
  };
  void reader.closed.then(release, release);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function discardGitHubResponseBody(response: Response) {
  if (!response.body || response.bodyUsed) return;
  await response.body.cancel().catch(() => undefined);
}

async function acquireGitHubRequestSlot(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  if (githubActiveRequests < githubMaxConcurrentRequests) {
    githubActiveRequests += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = githubRequestWaiters.indexOf(waiter);
        if (index < 0) return;
        githubRequestWaiters.splice(index, 1);
        reject(signal.reason);
      },
    };
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    githubRequestWaiters.push(waiter);
  });
}

function releaseGitHubRequestSlot() {
  while (true) {
    const next = githubRequestWaiters.shift();
    if (!next) {
      githubActiveRequests -= 1;
      return;
    }
    next.signal.removeEventListener('abort', next.onAbort);
    if (next.signal.aborted) {
      next.reject(next.signal.reason);
      continue;
    }
    next.resolve();
    return;
  }
}

export function clearGitHubRequestCache() {
  githubValidatorCache.clear();
  githubGetRequestsInFlight.clear();
  githubGraphqlQueriesInFlight.clear();
  githubLoginCache.clear();
  githubReadEpoch += 1;
  githubValidatorCacheBytes = 0;
}

async function readGitHubErrorData(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

export function nextLink(linkHeader: string | null) {
  if (!linkHeader) return undefined;

  for (const link of linkHeader.split(',')) {
    const match = link.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return match[1];
    }
  }

  return undefined;
}
