export const autopilotOwnerCapabilities = [
  'read',
  'edit',
  'diagnose',
  'commit',
  'push',
  'respond',
] as const;

export type AutopilotOwnerCapability =
  (typeof autopilotOwnerCapabilities)[number];

export type AutopilotOwnerCapabilitySet = ReadonlySet<AutopilotOwnerCapability>;
