export type LocalApiSession = {
  ok: boolean;
  token?: string | null;
  header?: string | null;
};

let sessionRequest: Promise<LocalApiSession | null> | null = null;

export function getLocalApiSession() {
  sessionRequest ??= fetch('/api/local-api/session')
    .then((response) =>
      response.ok ? (response.json() as Promise<LocalApiSession>) : null,
    )
    .catch(() => null);
  return sessionRequest;
}
