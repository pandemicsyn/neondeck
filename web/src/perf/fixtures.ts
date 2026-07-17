import type {
  DiffFilePatch,
  DiffReviewAnnotation,
} from '../features/diff-viewer/types';

export type DiffFixture = {
  patch: string;
  annotations: DiffReviewAnnotation[];
  changedLines: number;
  fileCount: number;
  lineWidth: number;
};

export function createDiffFixture({
  changedLines,
  fileCount = 1,
  lineWidth = 72,
  annotationCount = 0,
}: {
  changedLines: number;
  fileCount?: number;
  lineWidth?: number;
  annotationCount?: number;
}): DiffFixture {
  const changedLinesPerFile = Math.max(
    2,
    Math.floor(changedLines / fileCount / 2) * 2,
  );
  const patch = Array.from({ length: fileCount }, (_, index) =>
    createFilePatch(index, changedLinesPerFile, lineWidth),
  ).join('\n');
  const additionsPerFile = changedLinesPerFile / 2;
  const annotations = Array.from({ length: annotationCount }, (_, index) => ({
    side: 'additions' as const,
    lineNumber: 1 + (index % additionsPerFile),
    metadata: {
      id: `annotation-${index}`,
      kind: index % 2 === 0 ? ('thread' as const) : ('draft' as const),
      title: `Review note ${index + 1}`,
      body: `Deterministic annotation body ${index + 1}.`,
      authorLogin: 'benchmark',
      isResolved: false,
    },
  }));

  return {
    patch,
    annotations,
    changedLines: changedLinesPerFile * fileCount,
    fileCount,
    lineWidth,
  };
}

export function createDiffFiles(
  fileCount: number,
  changedLinesPerFile: number,
) {
  return Array.from({ length: fileCount }, (_, index) => {
    const patch = createFilePatch(index, changedLinesPerFile, 72);
    return {
      path: filePath(index),
      status: index % 11 === 0 ? 'added' : 'modified',
      additions: changedLinesPerFile / 2,
      deletions: changedLinesPerFile / 2,
      patch,
      truncated: false,
    } satisfies DiffFilePatch;
  });
}

export function createChatMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 3 === 0 ? ('user' as const) : ('assistant' as const),
    body: [
      `### Message ${index + 1}`,
      '',
      `This deterministic message exercises **Markdown**, links, and inline \`code_${index}\`.`,
      '',
      '| path | status |',
      '| --- | --- |',
      `| src/fixture-${index}.ts | ${index % 2 === 0 ? 'ready' : 'pending'} |`,
      '',
      '```ts',
      `export const fixture${index} = { index: ${index}, active: true };`,
      '```',
    ].join('\n'),
  }));
}

function createFilePatch(
  fileIndex: number,
  changedLines: number,
  lineWidth: number,
) {
  const path = filePath(fileIndex);
  const pairs = Math.max(1, Math.floor(changedLines / 2));
  const padding = 'x'.repeat(Math.max(0, lineWidth - 48));
  const deletions = Array.from(
    { length: pairs },
    (_, index) =>
      `-export const before_${fileIndex}_${index} = "${padding}${index}";`,
  );
  const additions = Array.from(
    { length: pairs },
    (_, index) =>
      `+export const after_${fileIndex}_${index} = "${padding}${index + 1}";`,
  );

  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${pairs} +1,${pairs} @@`,
    ...deletions,
    ...additions,
  ].join('\n');
}

function filePath(index: number) {
  return `src/fixtures/group-${Math.floor(index / 20)}/fixture-${index}.ts`;
}
