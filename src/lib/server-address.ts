/** The private server and its local clients share one loopback address contract. */
export function privateServerHost(env: NodeJS.ProcessEnv = process.env) {
  const host = env.NEONDECK_PRIVATE_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1')
    throw new Error(
      'Private listener must bind to loopback. Use an authenticated tunnel or SSH forwarding.',
    );
  return host;
}
export function privateServerUrl(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const host = privateServerHost(env);
  return `http://${host === '::1' ? '[::1]' : host}:${port}`;
}
