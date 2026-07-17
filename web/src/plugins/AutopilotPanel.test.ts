import { describe, expect, it } from 'vitest';
import type { AutopilotRecoveryOption } from '../api';
import { recoveryOptionStillAvailable } from './AutopilotPanel';

describe('recoveryOptionStillAvailable', () => {
  it('withdraws a selected recovery action when the server removes it', () => {
    const cleanup = recoveryOption('cleanup-worktree');

    expect(recoveryOptionStillAvailable(cleanup, [cleanup])).toBe(true);
    expect(recoveryOptionStillAvailable(cleanup, [])).toBe(false);
    expect(recoveryOptionStillAvailable(undefined, [])).toBe(true);
  });
});

function recoveryOption(
  id: AutopilotRecoveryOption['id'],
): AutopilotRecoveryOption {
  return {
    id,
    label: id,
    description: id,
    enabled: true,
    requires: [],
    destructive: id === 'cleanup-worktree',
    api: { method: 'POST', path: '/api/recovery' },
  };
}
