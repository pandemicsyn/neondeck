export type PatchAnchorSide = 'RIGHT' | 'LEFT';
export type PatchAnchor = { hunk: number; position: number };
export type PatchAnchorIndex = Map<string, PatchAnchor>;
export type ReviewCommentAnchor = {
  side: PatchAnchorSide;
  line: number;
  startLine?: number | null;
  startSide?: PatchAnchorSide | null;
};

export type VisiblePatchSide = 'additions' | 'deletions';
export type VisiblePatchLine = {
  number: number;
  text: string;
};

export function buildPatchAnchorIndex(patch: string | null | undefined) {
  const anchors: PatchAnchorIndex = new Map();
  if (!patch?.trim()) return anchors;
  for (const line of parseVisiblePatchLines(patch)) {
    if (line.additionsLine !== null) {
      anchors.set(patchAnchorKey('RIGHT', line.additionsLine), {
        hunk: line.hunk,
        position: line.position,
      });
    }
    if (line.deletionsLine !== null) {
      anchors.set(patchAnchorKey('LEFT', line.deletionsLine), {
        hunk: line.hunk,
        position: line.position,
      });
    }
  }
  return anchors;
}

export function visiblePatchLines(
  patch: string,
  side: VisiblePatchSide,
): VisiblePatchLine[] {
  return parseVisiblePatchLines(patch).flatMap((line) => {
    const number =
      side === 'additions' ? line.additionsLine : line.deletionsLine;
    return number === null ? [] : [{ number, text: line.text }];
  });
}

export function visiblePatchLineKeys(patch: string) {
  const keys = new Set<string>();
  for (const line of parseVisiblePatchLines(patch)) {
    if (line.additionsLine !== null) {
      keys.add(`additions:${line.additionsLine}`);
    }
    if (line.deletionsLine !== null) {
      keys.add(`deletions:${line.deletionsLine}`);
    }
  }
  return keys;
}

export function commentAnchorExists(
  index: PatchAnchorIndex,
  comment: ReviewCommentAnchor,
) {
  const endAnchor = index.get(patchAnchorKey(comment.side, comment.line));
  if (!endAnchor) return false;
  if (!comment.startLine) return true;
  const startAnchor = index.get(
    patchAnchorKey(comment.startSide ?? comment.side, comment.startLine),
  );
  if (!startAnchor) return false;
  return (
    startAnchor.hunk === endAnchor.hunk &&
    startAnchor.position <= endAnchor.position
  );
}

export function patchAnchorKey(side: PatchAnchorSide, line: number) {
  return `${side}:${line}`;
}

type ParsedVisiblePatchLine = {
  additionsLine: number | null;
  deletionsLine: number | null;
  hunk: number;
  position: number;
  text: string;
};

function parseVisiblePatchLines(patch: string): ParsedVisiblePatchLine[] {
  const result: ParsedVisiblePatchLine[] = [];
  let additionsLine = 0;
  let deletionsLine = 0;
  let hunk = -1;
  let position = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = line.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)/);
    if (header?.groups) {
      deletionsLine = Number(header.groups.old);
      additionsLine = Number(header.groups.next);
      hunk += 1;
      position = 0;
      continue;
    }
    if (hunk < 0) continue;
    if (
      line.startsWith('diff --git') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      continue;
    }

    position += 1;
    if (line.startsWith('+')) {
      result.push({
        additionsLine,
        deletionsLine: null,
        hunk,
        position,
        text: line.slice(1),
      });
      additionsLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      result.push({
        additionsLine: null,
        deletionsLine,
        hunk,
        position,
        text: line.slice(1),
      });
      deletionsLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      result.push({
        additionsLine,
        deletionsLine,
        hunk,
        position,
        text: line.slice(1),
      });
      additionsLine += 1;
      deletionsLine += 1;
    }
  }
  return result;
}
