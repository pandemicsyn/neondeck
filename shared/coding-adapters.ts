import * as v from 'valibot';
export const codingAdapterIdSchema = v.picklist(['codex', 'opencode', 'kilo']);
export const codingAdapterIdentitySchema = v.strictObject({
  id: codingAdapterIdSchema,
  contractVersion: v.literal(1),
  cliVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});
export const codingCapabilitySchema = v.strictObject({
  status: v.picklist(['supported', 'unsupported', 'unknown']),
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});
export const codingAdapterCapabilitiesSchema = v.strictObject({
  privateState: codingCapabilitySchema,
  nonInteractive: codingCapabilitySchema,
  cancellation: codingCapabilitySchema,
  osSandbox: codingCapabilitySchema,
  childSessions: codingCapabilitySchema,
});
export type CodingAdapterId = v.InferOutput<typeof codingAdapterIdSchema>;
export type CodingAdapterIdentity = v.InferOutput<
  typeof codingAdapterIdentitySchema
>;
export type CodingAdapterCapabilities = v.InferOutput<
  typeof codingAdapterCapabilitiesSchema
>;
export const codingAdapterMetadataSchema = v.strictObject({
  id: codingAdapterIdSchema,
  contractVersion: v.literal(1),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  capabilities: codingAdapterCapabilitiesSchema,
  supportedPlatforms: v.optional(
    v.array(
      v.picklist([
        'aix',
        'android',
        'darwin',
        'freebsd',
        'haiku',
        'linux',
        'openbsd',
        'sunos',
        'win32',
        'cygwin',
        'netbsd',
      ]),
    ),
  ),
  supportedVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  credentialKinds: v.array(v.picklist(['api-key', 'auth-json'])),
});
export type CodingAdapterMetadata = v.InferOutput<
  typeof codingAdapterMetadataSchema
>;
export const codingExecutableIdentitySchema = v.strictObject({
  canonical: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  device: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  inode: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  modified: v.number(),
  // Missing only on historical records; never sufficient for new execution.
  sha256: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});
export type CodingExecutableIdentity = v.InferOutput<
  typeof codingExecutableIdentitySchema
>;

export const codingPinnedExecutableIdentitySchema = v.strictObject({
  ...codingExecutableIdentitySchema.entries,
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type CodingPinnedExecutableIdentity = v.InferOutput<
  typeof codingPinnedExecutableIdentitySchema
>;
