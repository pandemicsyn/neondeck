import { describe, expect, it } from 'vitest';
import { defaultCommandCatalog } from '../types';
import { filterCommands, mergeCommandCatalog } from './commands';

describe('chat command catalog', () => {
  it('keeps review-pr available in the offline fallback catalog', () => {
    expect(defaultCommandCatalog).toContainEqual(
      expect.objectContaining({ command: '/review-pr' }),
    );
  });

  it('adds commands from the backend registry without requiring dashboard config changes', () => {
    const catalog = mergeCommandCatalog(
      [{ label: 'Queue override', command: '/review-queue' }],
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
});
