/**
 * Bounds reconstructed model-visible context for the continuing owner. Flue's
 * canonical append-only event stream remains durable and is not compacted by
 * this setting.
 */
export const prAutopilotOwnerCompaction = {
  reserveTokens: 16_000,
  keepRecentTokens: 8_000,
} as const;

export const prAutopilotOwnerDurability = {
  maxAttempts: 10,
  timeoutMs: 60 * 60 * 1_000,
} as const;
