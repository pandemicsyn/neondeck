import * as v from 'valibot';
import { githubGraphqlBaseResponseSchema } from './schemas';
import { githubErrorMessage, isRequestTimeout } from './errors';

const githubRequestTimeoutMs = 15_000;

export async function fetchGitHubLogin(token: string) {
  const response = await githubFetch(token, 'https://api.github.com/user');
  const data = v.parse(
    v.object({
      login: v.string(),
    }),
    await response.json(),
  );
  if (!data.login) {
    throw new Error('GitHub API did not return a login');
  }
  return data.login;
}

export async function githubGraphqlFetch(
  token: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await githubFetch(token, 'https://api.github.com/graphql', {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  });
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
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        'User-Agent': 'neondeck',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(githubRequestTimeoutMs),
    });
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw new Error(
        `GitHub request timed out after ${Math.round(githubRequestTimeoutMs / 1000)}s`,
      );
    }

    throw error;
  }

  if (!response.ok) {
    throw new Error(githubErrorMessage(response));
  }

  return response;
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
