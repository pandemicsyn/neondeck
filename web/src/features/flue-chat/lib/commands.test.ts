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
      expect.objectContaining({
        label: 'Queue override',
        name: 'review-queue',
        description: 'Fetch the review queue.',
        scope: 'main',
        dispatch: { kind: 'app-command' },
      }),
      expect.objectContaining({
        label: 'Inspect Release',
        name: 'inspect-release',
        description: 'Inspect a release candidate.',
        usage: '/inspect-release <repo>',
      }),
    ]);
    expect(filterCommands(catalog, 'release')).toEqual([
      expect.objectContaining({ name: 'inspect-release' }),
    ]);
  });

  it('keeps configured commands when the backend registry is unavailable', () => {
    expect(
      mergeCommandCatalog([
        { label: 'Local command', command: '/local-command' },
      ]),
    ).toContainEqual(
      expect.objectContaining({
        label: 'Local command',
        name: 'local-command',
      }),
    );
  });

  it('preserves preset arguments when completing a configured command', () => {
    expect(
      mergeCommandCatalog(
        [
          {
            label: 'Review target',
            command: '/review-pr owner/repo#12',
          },
        ],
        [
          {
            name: 'review-pr',
            usage: '/review-pr <owner/repo#number>',
            description: 'Review one pull request.',
          },
        ],
      ),
    ).toContainEqual(
      expect.objectContaining({
        completion: '/review-pr owner/repo#12',
        name: 'review-pr',
        usage: '/review-pr <owner/repo#number>',
      }),
    );
  });

  it('clamps the active command index when suggestions shrink', () => {
    expect(clampCommandIndex(5, 2)).toBe(1);
    expect(clampCommandIndex(-1, 2)).toBe(0);
    expect(clampCommandIndex(2, 0)).toBe(0);
  });
});
