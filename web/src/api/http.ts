import { getLocalApiSession } from './local-api-session';
import {
  externalErrorMessage,
  externalRecord,
  webExternalValueSchema,
  type WebExternalValue,
} from './schemas';
import * as v from 'valibot';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly data: WebExternalValue,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiRequestOptions = { signal?: AbortSignal };

export async function getJson<T>(url: string, options: ApiRequestOptions = {}) {
  const response = await fetch(url, { signal: options.signal });
  return readJsonResponse<T>(response, url);
}

export async function getAuthorizedJson<T>(
  url: string,
  options: ApiRequestOptions = {},
) {
  const session = await getLocalApiSession();
  const headers = new Headers();
  if (session?.token) {
    headers.set(session.header || 'x-neondeck-api-token', session.token);
  }
  const response = await fetch(url, { headers, signal: options.signal });
  return readJsonResponse<T>(response, url);
}

export async function postJson<T>(
  url: string,
  body: WebExternalValue,
  options: ApiRequestOptions = {},
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
  body: WebExternalValue,
  options: ApiRequestOptions = {},
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
  body: WebExternalValue,
  options: ApiRequestOptions = {},
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
  options: ApiRequestOptions = {},
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
  let data: WebExternalValue;

  if (hasBody && expectsJson) {
    try {
      data = v.parse(webExternalValueSchema, JSON.parse(text));
    } catch (cause) {
      throw new Error(
        `Invalid JSON response from ${url}: ${externalErrorMessage(cause)}`,
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

  // SAFETY: Endpoint wrappers bind T to the corresponding server response
  // contract; this transport owns the single unchecked handoff after JSON
  // syntax validation so individual consumers do not repeat assertions.
  return data as T;
}

function readErrorMessage(data: WebExternalValue) {
  const record = externalRecord(data);
  if (!record) return undefined;

  const message = v.safeParse(v.string(), record.message);
  if (message.success) return message.output;

  const errorText = v.safeParse(v.string(), record.error);
  if (errorText.success) return errorText.output;

  const errorRecord = externalRecord(record.error);
  if (errorRecord && 'message' in errorRecord) {
    return String(errorRecord.message);
  }

  return undefined;
}

function readTextErrorMessage(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 400) : undefined;
}
