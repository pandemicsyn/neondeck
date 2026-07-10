import type { DiffFilePatch } from './types';

const diffGitHeader = /^diff --git a\/(.+?) b\/(.+)$/gm;

export function patchHasContent(patch: string | null | undefined) {
  return Boolean(patch && patch.trim().length > 0);
}

export function patchFilePaths(patch: string | null | undefined) {
  if (!patch) return [];
  const paths: string[] = [];
  for (const match of patch.matchAll(diffGitHeader)) {
    const path = match[2] ?? match[1];
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

export function joinFilePatches(files: DiffFilePatch[]) {
  return files
    .map((file) => file.patch?.trimEnd() ?? '')
    .filter(Boolean)
    .join('\n');
}

export function splitUnifiedPatchFiles(
  patch: string | null | undefined,
): DiffFilePatch[] {
  const source = patch ?? '';
  if (!patchHasContent(source)) return [];

  const matches = [...source.matchAll(diffGitHeader)];
  if (matches.length === 0) {
    return [
      {
        additions: 0,
        deletions: 0,
        path: 'patch.diff',
        status: 'M',
        patch: null,
        message: 'Patch is not in canonical git diff format.',
      },
    ];
  }

  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const next = matches[index + 1];
    const end = next?.index ?? source.length;
    const filePatch = source.slice(start, end).trimEnd();
    const path = match[2] ?? match[1] ?? 'patch.diff';
    return {
      additions: countPatchLines(filePatch, '+'),
      binary: /Binary files .+ differ/.test(filePatch),
      deletions: countPatchLines(filePatch, '-'),
      generatedLike: false,
      path,
      status: patchStatus(filePatch),
      patch: `${filePatch}\n`,
      truncated: false,
    };
  });
}

export function diffFileCountLabel(count: number) {
  return `${count} file${count === 1 ? '' : 's'}`;
}

export function diffStatsLabel(file: DiffFilePatch) {
  if (file.binary) return 'binary';
  const additions = Number.isFinite(file.additions) ? file.additions : 0;
  const deletions = Number.isFinite(file.deletions) ? file.deletions : 0;
  return `+${additions} -${deletions}`;
}

export function firstRenderablePath(files: DiffFilePatch[]) {
  return (
    files.find((file) => patchHasContent(file.patch))?.path ?? files[0]?.path
  );
}

export function filePatchStatus(file: DiffFilePatch) {
  if (file.binary) return 'binary file';
  if (file.truncated) return 'patch truncated';
  if (patchHasContent(file.patch)) return null;
  return file.message ?? 'No patch available for this file.';
}

function countPatchLines(patch: string, marker: '+' | '-') {
  const excludedPrefix = marker === '+' ? '+++' : '---';
  return patch
    .split('\n')
    .filter(
      (line) => line.startsWith(marker) && !line.startsWith(excludedPrefix),
    ).length;
}

function patchStatus(patch: string) {
  if (/^new file mode /m.test(patch)) return 'A';
  if (/^deleted file mode /m.test(patch)) return 'D';
  if (/^---\s+\/dev\/null$/m.test(patch)) return 'A';
  if (/^\+\+\+\s+\/dev\/null$/m.test(patch)) return 'D';
  if (/^rename from /m.test(patch)) return 'R';
  return 'M';
}
