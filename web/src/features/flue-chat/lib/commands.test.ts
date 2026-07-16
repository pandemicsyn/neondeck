import { describe, expect, it } from 'vitest';
import { defaultCommandCatalog } from '../types';
import {
  clampCommandIndex,
  filterCommands,
  mergeCommandCatalog,
} from './commands';

describe('chat command catalog', () => {
  it('keeps review-pr available in the offline fallback catalog', () => {
    expect(defaultCommandCatalog).toContainEqual(
      expect.objectContaining({ command: '/review-pr' }),
    );
  });

  it('adds commands from the backend registry without requiring dashboard config changes', () => {
    const catalog = mergeCommandCatalog(
      [
        { label: 'Queue override', command: '/review-queue' },
        { label: 'Removed command', command: '/removed-command' },
      ],
      [
        {
          name: 'review-queue',
          usage: '/review-queue',
          description: 'Fetch the review queue.',
        },
        {
          name: 'inspect-release',
          usage: '/inspect-release <repo>',
          description: 'Inspect a release candidate.',
        },
      ],
    );

    expect(catalog).toEqual([
      {
        label: 'Queue override',
        command: '/review-queue',
        description: 'Fetch the review queue.',
      },
      {
        label: 'Inspect Release',
        command: '/inspect-release',
        description: 'Inspect a release candidate.',
      },
    ]);
    expect(filterCommands(catalog, 'release')).toEqual([
      expect.objectContaining({ command: '/inspect-release' }),
    ]);
  });

  it('keeps configured commands when the backend registry is unavailable', () => {
    expect(
      mergeCommandCatalog([
        { label: 'Local command', command: '/local-command' },
      ]),
    ).toContainEqual({ label: 'Local command', command: '/local-command' });
  });

  it('clamps the active command index when suggestions shrink', () => {
    expect(clampCommandIndex(5, 2)).toBe(1);
    expect(clampCommandIndex(-1, 2)).toBe(0);
    expect(clampCommandIndex(2, 0)).toBe(0);
  });
});
