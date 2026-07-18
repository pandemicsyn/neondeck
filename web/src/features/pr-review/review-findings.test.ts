import { describe, expect, it } from 'vitest';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { buildPatchAnchorIndex } from '../../../../shared/patch-anchors';
import type { DiffFilePatch } from '../diff-viewer/types';
import {
  annotationsFromNeonFindings,
  currentActiveNeonFindings,
  resolveNeonFindingAnchor,
} from './review-findings';

const sourceId = 'github-pr:example/repo#42';
const revisionKey = 'git-commit::head-sha';

describe('typed Neon review findings', () => {
  it('resolves line ranges and hunk anchors only against exact patch locations', () => {
    const file = changedFile('src/a.ts', patch());
    const index = buildPatchAnchorIndex(file.patch);
    const range = finding('range', {
      anchor: {
        kind: 'line-range',
        side: 'additions',
        startLine: 2,
        endLine: 3,
      },
    });
    expect(
      resolveNeonFindingAnchor(range, file, index, sourceId, revisionKey),
    ).toMatchObject({
      state: 'anchored',
      lineNumber: 3,
      selection: { side: 'additions', start: 2, end: 3 },
    });

    const hunk = finding('hunk', {
      anchor: { kind: 'hunk', side: 'deletions', hunkId: '1:10:12' },
    });
    expect(
      resolveNeonFindingAnchor(hunk, file, index, sourceId, revisionKey),
    ).toMatchObject({ state: 'anchored', lineNumber: 10, side: 'deletions' });

    expect(
      resolveNeonFindingAnchor(
        finding('missing-hunk', {
          anchor: { kind: 'hunk', side: 'additions', hunkId: '9:99:99' },
        }),
        file,
        index,
        sourceId,
        revisionKey,
      ),
    ).toMatchObject({ state: 'unavailable' });
  });

  it('keeps stale, dismissed, resolved, and promoted findings out of inline projection', () => {
    const file = changedFile('src/a.ts', patch());
    const findings = (
      ['stale', 'dismissed', 'resolved', 'promoted'] as const
    ).map((state) =>
      finding(state, {
        lifecycle: {
          state,
          changedAt: '2026-07-18T12:10:00.000Z',
          reason: `${state} reason`,
          promotion: null,
        },
      }),
    );
    expect(currentActiveNeonFindings(findings, sourceId, revisionKey)).toEqual(
      [],
    );
    expect(
      annotationsFromNeonFindings({
        files: [file],
        findings,
        indexes: new Map([['src/a.ts', buildPatchAnchorIndex(file.patch)]]),
        revisionKey,
        sourceId,
      }),
    ).toEqual({});
  });

  it('projects a 305-file metadata set without requesting patches or mounting unbounded annotations', () => {
    const files = Array.from({ length: 305 }, (_, index) => {
      const file = changedFile(`src/file-${index}.ts`);
      if (index === 0) file.patch = patch();
      return file;
    });
    const findings = Array.from({ length: 200 }, (_, index) =>
      finding(`finding-${index}`, { file: files[index]!.path }),
    );
    const projected = annotationsFromNeonFindings({
      files,
      findings,
      indexes: new Map([
        [files[0]!.path, buildPatchAnchorIndex(files[0]!.patch)],
      ]),
      revisionKey,
      sourceId,
    });

    expect(Object.values(projected).flat()).toHaveLength(1);
    expect(files).toHaveLength(305);
  });
});

function finding(
  id: string,
  overrides: Partial<NeonReviewFinding> = {},
): NeonReviewFinding {
  return {
    schemaVersion: 2,
    id,
    surfaceId: 'surface-a',
    sourceId,
    revisionKey,
    file: 'src/a.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 2,
      endLine: 2,
    },
    title: `Finding ${id}`,
    explanation: 'Finding explanation.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: 'Apply the safe fix.',
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5',
      workflowRunId: 'run-1',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    lifecycle: {
      state: 'active',
      changedAt: '2026-07-18T12:00:00.000Z',
      reason: null,
      promotion: null,
    },
    ...overrides,
  };
}

function changedFile(path: string, filePatch?: string): DiffFilePatch {
  return {
    additions: 4,
    deletions: 2,
    path,
    patch: filePatch,
    status: 'modified',
  };
}

function patch() {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' line 1',
    '+line 2',
    '+line 3',
    ' line 4',
    '@@ -10,2 +12,2 @@',
    '-old line',
    '+new line',
    ' context',
  ].join('\n');
}
