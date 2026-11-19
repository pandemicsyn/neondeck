export const defaultServerPort = 3583;

export function resolveServerPort(value?: number | string) {
  const raw = value ?? process.env.NEONDECK_PORT ?? process.env.PORT;
  if (raw === undefined || raw === '') return defaultServerPort;
  const port = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Port must be an integer between 1 and 65535, got ${JSON.stringify(raw)}.`,
    );
  }
  return port;
}

export function localServerUrl() {
  return `http://127.0.0.1:${resolveServerPort()}`;
}
