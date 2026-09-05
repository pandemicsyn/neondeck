import * as v from 'valibot';

const privateHostSchema = v.optional(
  v.picklist(
    ['127.0.0.1', '::1'],
    'Private listener must bind to loopback. Use an authenticated tunnel or SSH forwarding.',
  ),
  '127.0.0.1',
);
const portMessage = 'Listener port must be between 1 and 65535.';
const portSchema = v.pipe(
  v.string(),
  v.transform(Number),
  v.number(portMessage),
  v.integer(portMessage),
  v.minValue(1, portMessage),
  v.maxValue(65535, portMessage),
);
const listenerSchema = v.pipe(
  v.object({
    privateHost: privateHostSchema,
    privatePort: v.optional(portSchema, '3583'),
    publicHost: v.optional(v.string(), '127.0.0.1'),
    publicPort: v.nullable(portSchema),
  }),
  v.check(
    (value) => value.privatePort !== value.publicPort,
    'Public and private listener ports must differ.',
  ),
);

/** Normalize already-loaded environment values; runtime-home loading owns precedence. */
export function normalizeListenerEnv(env: NodeJS.ProcessEnv = process.env) {
  return v.parse(listenerSchema, {
    privateHost: env.NEONDECK_PRIVATE_HOST,
    privatePort: env.NEONDECK_PORT ?? env.PORT,
    publicHost: env.NEONDECK_INGRESS_HOST,
    publicPort: env.NEONDECK_INGRESS_PORT || null,
  });
}

/** The private server and its local clients share one loopback address contract. */
export function privateServerHost(env: NodeJS.ProcessEnv = process.env) {
  return v.parse(privateHostSchema, env.NEONDECK_PRIVATE_HOST);
}
export function privateServerUrl(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const host = privateServerHost(env);
  return `http://${host === '::1' ? '[::1]' : host}:${port}`;
}
