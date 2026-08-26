import { describe, expect, it } from 'vitest';
import {
  buildPublishedUpdateManifest,
  manifestChannelIncludesRelease,
  parseUpdateManifest,
} from './modules/updates/manifest';

describe('Neondeck update manifest', () => {
  it('builds both npm channels with the newest tagged publication date', () => {
    expect(
      buildPublishedUpdateManifest({
        'dist-tags': {
          latest: '1.0.0',
          next: '1.1.0-beta.2',
        },
        time: {
          '1.0.0': '2026-08-20T10:00:00.000Z',
          '1.1.0-beta.2': '2026-08-24T11:00:00.000Z',
        },
      }),
    ).toEqual({
      schema: 1,
      latest: '1.0.0',
      next: '1.1.0-beta.2',
      date: '2026-08-24T11:00:00.000Z',
      msg: '',
    });
  });

  it('allows a channel to be absent before it has been published', () => {
    expect(
      buildPublishedUpdateManifest({
        'dist-tags': { next: '1.0.0-beta.1' },
        time: { '1.0.0-beta.1': '2026-08-24T11:00:00.000Z' },
      }),
    ).toMatchObject({ latest: null, next: '1.0.0-beta.1' });
  });

  it('accepts an expected release after its npm channel advances', () => {
    const manifest = buildPublishedUpdateManifest({
      'dist-tags': { next: '1.0.0-beta.40' },
      time: { '1.0.0-beta.40': '2026-08-24T11:00:00.000Z' },
    });
    expect(
      manifestChannelIncludesRelease(manifest, 'next', '1.0.0-beta.39'),
    ).toBe(true);
    expect(
      manifestChannelIncludesRelease(manifest, 'next', '1.0.0-beta.41'),
    ).toBe(false);
  });

  it('requires a valid publication date for every tagged channel', () => {
    expect(() =>
      buildPublishedUpdateManifest({
        'dist-tags': { latest: '1.0.0', next: '1.1.0-beta.1' },
        time: { '1.0.0': '2026-08-24T11:00:00.000Z' },
      }),
    ).toThrow('no publication date for 1.1.0-beta.1');
    expect(() =>
      buildPublishedUpdateManifest({
        'dist-tags': { next: '1.1.0-beta.1' },
        time: { '1.1.0-beta.1': 'not-a-date' },
      }),
    ).toThrow('invalid publication date for 1.1.0-beta.1');
  });

  it('rejects malformed or incomplete public manifests', () => {
    expect(
      parseUpdateManifest({
        schema: 1,
        latest: '1.0.0',
        next: 'broken',
        date: '2026-08-24T11:00:00.000Z',
        msg: '',
      }),
    ).toBeNull();
    expect(
      parseUpdateManifest({
        schema: 1,
        latest: null,
        next: null,
        date: '2026-08-24T11:00:00.000Z',
        msg: '',
      }),
    ).toBeNull();
  });
});
