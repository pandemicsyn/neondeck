import { describe, expect, it } from 'vitest';
import {
  joinFilePatches,
  patchChangedLineCount,
  patchFilePaths,
  patchHasContent,
  splitUnifiedPatchFiles,
} from './helpers';

describe('diff viewer patch helpers', () => {
  it('counts changed rows without treating file headers as changes', () => {
    expect(
      patchChangedLineCount(
        [
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1,2 +1,2 @@',
          '-before',
          '+after',
          ' context',
          '++++content-that-starts-with-plus-markers',
        ].join('\n'),
      ),
    ).toBe(3);
    expect(patchChangedLineCount(undefined)).toBe(0);
  });

  it('treats empty and whitespace-only patches as absent', () => {
    expect(patchHasContent('')).toBe(false);
    expect(patchHasContent('  \n')).toBe(false);
    expect(patchFilePaths('')).toEqual([]);
  });

  it('extracts unique file paths from unified patches', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/src/b.tsx b/src/b.tsx',
      'index 333..444 100644',
      '--- a/src/b.tsx',
      '+++ b/src/b.tsx',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    expect(patchFilePaths(patch)).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('preserves no-trailing-newline markers when joining file patches', () => {
    const joined = joinFilePatches([
      {
        additions: 1,
        deletions: 1,
        path: 'src/a.ts',
        status: 'M',
        patch: [
          'diff --git a/src/a.ts b/src/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '\\ No newline at end of file',
        ].join('\n'),
      },
      {
        additions: 1,
        deletions: 0,
        path: 'src/b.ts',
        status: 'A',
        patch: 'diff --git a/src/b.ts b/src/b.ts\n@@ -0,0 +1 @@\n+new\n',
      },
    ]);

    expect(joined).toContain('\\ No newline at end of file');
    expect(patchFilePaths(joined)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(splitUnifiedPatchFiles(joined).map((file) => file.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('marks non-canonical patches as unrenderable', () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@',
      '-old',
      '+new',
      '',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@',
      '-before',
      '+after',
      '+extra',
      '',
    ].join('\n');

    const files = splitUnifiedPatchFiles(patch);

    expect(patchFilePaths(patch)).toEqual([]);
    expect(files).toMatchObject([
      {
        additions: 0,
        deletions: 0,
        path: 'patch.diff',
        status: 'M',
        patch: null,
        message: 'Patch is not in canonical git diff format.',
      },
    ]);
  });

  it('handles large patches without scanning line-by-line manually', () => {
    const body = Array.from({ length: 5000 }, (_, index) => `+line ${index}`);
    const patch = [
      'diff --git a/huge.txt b/huge.txt',
      '--- a/huge.txt',
      '+++ b/huge.txt',
      '@@ -0,0 +1,5000 @@',
      ...body,
    ].join('\n');

    expect(patchHasContent(patch)).toBe(true);
    expect(patchFilePaths(patch)).toEqual(['huge.txt']);
    expect(splitUnifiedPatchFiles(patch)).toMatchObject([
      {
        additions: 5000,
        deletions: 0,
        path: 'huge.txt',
        status: 'M',
      },
    ]);
  });
});
