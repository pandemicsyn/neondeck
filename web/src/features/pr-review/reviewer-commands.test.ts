import { describe, expect, it } from 'vitest';
import {
  prReviewerSlashCommands,
  resolvePrReviewerCommand,
} from './reviewer-commands';

describe('PR reviewer slash commands', () => {
  it('keeps the catalog reviewer-scoped and excludes global commands', () => {
    expect(prReviewerSlashCommands.map((command) => command.name)).toEqual([
      'help',
      're-review',
      'show-me',
    ]);
    expect(
      prReviewerSlashCommands.every(
        (command) => command.scope === 'pr-reviewer',
      ),
    ).toBe(true);
    expect(
      prReviewerSlashCommands.flatMap((command) => command.aliases ?? []),
    ).toContain('tour');
    expect(
      prReviewerSlashCommands.map((command) => command.name),
    ).not.toContain('memory');
  });

  it('normalizes the tour alias to the guided-explanation intent', () => {
    expect(resolvePrReviewerCommand('/tour the cache path', null)).toEqual({
      kind: 'agent-message',
      message: '/show-me the cache path',
    });
  });

  it('uses an active diff selection when show-me has no arguments', () => {
    const result = resolvePrReviewerCommand('/show-me', {
      path: 'src/cache.ts',
      selection: {
        start: 12,
        end: 14,
        side: 'additions',
        endSide: 'additions',
      } as never,
    });
    expect(result).toMatchObject({ kind: 'agent-message' });
    expect(result && 'message' in result ? result.message : '').toContain(
      '"path":"src/cache.ts"',
    );
  });

  it('returns local usage and contextual unknown-command errors', () => {
    expect(resolvePrReviewerCommand('/show-me', null)).toEqual({
      kind: 'error',
      message: 'Usage: /show-me <flow, behavior, or area>',
    });
    expect(resolvePrReviewerCommand('/memory list', null)).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Available here: /help, /re-review'),
    });
    for (const malformed of ['/', '/ help', '/\nfoo']) {
      expect(resolvePrReviewerCommand(malformed, null)).toMatchObject({
        kind: 'error',
        message: expect.stringContaining('Invalid reviewer command'),
      });
    }
  });
});
