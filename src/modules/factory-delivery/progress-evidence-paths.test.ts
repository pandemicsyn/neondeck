import { describe, expect, it } from 'vitest';
import { isSensitiveProgressDiffPath } from './progress-evidence';

describe('progress diff sensitive path filter', () => {
  it.each(['.git', '.git/config', 'nested/.git', 'nested/.git/config'])(
    'refuses the exact .git component in %s',
    (path) => expect(isSensitiveProgressDiffPath(path)).toBe(true),
  );

  it.each([
    '.github/workflows/checks.yml',
    '.gitignore',
    '.gitattributes',
    'nested/.github/workflows/checks.yml',
    'nested/.gitignore',
    'nested/.gitattributes',
  ])('allows ordinary repository metadata at %s', (path) => {
    expect(isSensitiveProgressDiffPath(path)).toBe(false);
  });

  it.each([
    '.env',
    '.env.local',
    'credentials/token',
    'secrets/token',
    'key.pem',
  ])('continues to refuse sensitive paths at %s', (path) =>
    expect(isSensitiveProgressDiffPath(path)).toBe(true),
  );
});
