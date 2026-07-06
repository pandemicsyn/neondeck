export type PatchAnchorSide = 'RIGHT' | 'LEFT';
export type PatchAnchor = { hunk: number; position: number };
export type PatchAnchorIndex = Map<string, PatchAnchor>;
export type ReviewCommentAnchor = {
  side: PatchAnchorSide;
  line: number;
  startLine?: number | null;
  startSide?: PatchAnchorSide | null;
};

export function buildPatchAnchorIndex(patch: string | null | undefined) {
  const anchors: PatchAnchorIndex = new Map();
  if (!patch?.trim()) return anchors;
  let oldLine = 0;
  let newLine = 0;
  let hunk = -1;
  let position = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = line.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)/);
    if (header?.groups) {
      oldLine = Number(header.groups.old);
      newLine = Number(header.groups.next);
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
      anchors.set(patchAnchorKey('RIGHT', newLine), { hunk, position });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      anchors.set(patchAnchorKey('LEFT', oldLine), { hunk, position });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(' ')) {
      anchors.set(patchAnchorKey('LEFT', oldLine), { hunk, position });
      anchors.set(patchAnchorKey('RIGHT', newLine), { hunk, position });
      oldLine += 1;
      newLine += 1;
    }
  }
  return anchors;
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
