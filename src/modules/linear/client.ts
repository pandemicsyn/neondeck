import * as v from 'valibot';

/** Provider details are intentionally excluded from durable/user-visible errors. */
export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly retryAt = Date.now() + 60_000,
    public readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

const envelope = v.object({
  data: v.optional(v.unknown()),
  errors: v.optional(
    v.array(
      v.object({
        extensions: v.optional(v.object({ code: v.optional(v.string()) })),
      }),
    ),
  ),
});

/** Fixed origin, bounded body and whole-request deadline; retries belong to durable callers. */
export async function linearGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
  beforeDispatch?: () => void,
): Promise<unknown> {
  if (!token) throw new LinearApiError('Linear token is unavailable.', 401);
  const controller = new AbortController();
  const requestSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LinearApiError('Linear request deadline exceeded.'));
    }, 15_000);
  });
  const operation = async () => {
    const init: RequestInit = {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    };
    requestSignal.throwIfAborted();
    beforeDispatch?.();
    const response = await fetch('https://api.linear.app/graphql', init);
    reader = response.body?.getReader();
    if (!reader) throw new LinearApiError('Linear returned no response body.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024)
          throw new LinearApiError('Linear response exceeds size limit.');
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 60;
    const retryAt = Date.now() + Math.min(Math.max(seconds, 1), 86400) * 1000;
    if (!response.ok)
      throw new LinearApiError(
        'Linear API request failed.',
        response.status,
        retryAt,
        response.status === 429,
      );
    let parsed: v.InferOutput<typeof envelope>;
    try {
      parsed = v.parse(
        envelope,
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, size),
          ),
        ),
      );
    } catch {
      throw new LinearApiError('Linear returned an invalid response.');
    }
    if (parsed.errors?.length) {
      const limited = parsed.errors.some(
        (error) => error.extensions?.code === 'RATELIMITED',
      );
      throw new LinearApiError(
        limited
          ? 'Linear API rate limit reached.'
          : 'Linear GraphQL request failed.',
        limited ? 429 : 502,
        retryAt,
        limited,
      );
    }
    if (parsed.data === undefined || parsed.data === null)
      throw new LinearApiError('Linear returned no result.');
    return parsed.data;
  };
  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error instanceof LinearApiError) throw error;
    throw new LinearApiError('Linear request failed.');
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
