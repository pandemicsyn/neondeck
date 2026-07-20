import { createHash } from 'node:crypto';

/**
 * Returns the stable Flue instance id reserved for one watched PR.
 *
 * The id intentionally has no generation component: routine feedback and restarts
 * must reuse the same continuing owner.
 */
export function autopilotOwnerInstanceId(watchId: string) {
  const normalized = watchId.trim();
  if (!normalized) throw new Error('Autopilot owner watch id is required.');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `pr-owner-${digest}`;
}
