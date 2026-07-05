export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getJson<T>(
  url: string,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(url, { signal: options.signal });
  return readJsonResponse<T>(response, url);
}

export async function postJson<T>(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return readJsonResponse<T>(response, url);
}

export async function putJson<T>(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return readJsonResponse<T>(response, url);
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return readJsonResponse<T>(response, url);
}

export async function deleteJson<T>(
  url: string,
  options: { signal?: AbortSignal } = {},
) {
  const response = await fetch(url, {
    method: 'DELETE',
    signal: options.signal,
  });
  return readJsonResponse<T>(response, url);
}

async function readJsonResponse<T>(response: Response, url: string) {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const hasBody = text.trim().length > 0;
  const expectsJson = contentType.toLowerCase().includes('json');
  let data: unknown;

  if (hasBody && expectsJson) {
    try {
      data = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new Error(
        `Invalid JSON response from ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  } else if (hasBody && response.ok) {
    throw new Error(
      `Expected JSON response from ${url}, received ${contentType || 'unknown content type'}.`,
    );
  }

  if (!response.ok) {
    const message =
      readErrorMessage(data) ??
      readTextErrorMessage(text) ??
      `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, url, data);
  }

  return data as T;
}

function readErrorMessage(data: unknown) {
  if (!data || typeof data !== 'object') return undefined;

  if ('message' in data && typeof data.message === 'string') {
    return data.message;
  }

  if (!('error' in data)) return undefined;

  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }

  return undefined;
}

function readTextErrorMessage(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 400) : undefined;
}
