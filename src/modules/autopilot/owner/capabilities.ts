export const autopilotOwnerCapabilities = [
  'workspace',
  'commit',
  'push',
  'respond',
] as const;

export type AutopilotOwnerCapability =
  (typeof autopilotOwnerCapabilities)[number];

export type AutopilotOwnerCapabilitySet = ReadonlySet<AutopilotOwnerCapability>;
