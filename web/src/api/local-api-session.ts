import * as v from 'valibot';

export type LocalApiSession = {
  ok: boolean;
  token?: string | null;
  header?: string | null;
};

const localApiSessionSchema = v.object({
  ok: v.boolean(),
  token: v.optional(v.nullable(v.string())),
  header: v.optional(v.nullable(v.string())),
});

let sessionRequest: Promise<LocalApiSession | null> | null = null;

export function getLocalApiSession() {
  sessionRequest ??= fetch('/api/local-api/session')
    .then(async (response) =>
      response.ok
        ? v.parse(localApiSessionSchema, await response.json())
        : null,
    )
    .catch(() => null);
  return sessionRequest;
}
