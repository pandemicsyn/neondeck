export type ReplaceMode = 'exact' | 'normalized-whitespace' | 'fuzzy';

export type ReplaceCandidate = {
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
};

export type ReplaceSuccess = {
  ok: true;
  content: string;
  matched: ReplaceMode;
  replacements: number;
};

export type ReplaceFailure = {
  ok: false;
  code: 'NO_MATCH' | 'AMBIGUOUS_MATCH' | 'LOW_CONFIDENCE';
  message: string;
  candidates: ReplaceCandidate[];
};

export function replaceContent(
  content: string,
  input: {
    oldString: string;
    newString: string;
    replaceAll?: boolean;
    fuzzy?: 'off' | 'safe';
  },
): ReplaceSuccess | ReplaceFailure {
  const exactIndexes = allIndexes(content, input.oldString);
  if (exactIndexes.length === 1) {
    return {
      ok: true,
      content: replaceAt(
        content,
        exactIndexes[0]!,
        input.oldString.length,
        input.newString,
      ),
      matched: 'exact',
      replacements: 1,
    };
  }

  if (exactIndexes.length > 1) {
    if (!input.replaceAll) {
      return {
        ok: false,
        code: 'AMBIGUOUS_MATCH',
        message: `The old string matched ${exactIndexes.length} locations. Provide more surrounding lines or set replaceAll.`,
        candidates: exactIndexes
          .slice(0, 5)
          .map((index) =>
            candidateFromIndex(content, index, input.oldString.length, 1),
          ),
      };
    }

    return {
      ok: true,
      content: content.split(input.oldString).join(input.newString),
      matched: 'exact',
      replacements: exactIndexes.length,
    };
  }

  if ((input.fuzzy ?? 'off') === 'off') {
    return {
      ok: false,
      code: 'NO_MATCH',
      message:
        'The old string was not found. Re-read the file and retry with current context.',
      candidates: nearbyCandidates(content, input.oldString),
    };
  }

  const normalized = normalizedWhitespaceMatch(content, input.oldString);
  if (normalized.length === 1) {
    const match = normalized[0]!;
    return {
      ok: true,
      content: replaceAt(content, match.index, match.length, input.newString),
      matched: 'normalized-whitespace',
      replacements: 1,
    };
  }

  if (normalized.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_MATCH',
      message:
        'The old string matched multiple locations after whitespace normalization. Provide more surrounding lines.',
      candidates: normalized
        .slice(0, 5)
        .map((match) =>
          candidateFromIndex(content, match.index, match.length, 0.9),
        ),
    };
  }

  const candidates = nearbyCandidates(content, input.oldString);
  const [best, second] = candidates;
  if (!best || best.score < 0.72) {
    return {
      ok: false,
      code: 'LOW_CONFIDENCE',
      message:
        'No safe fuzzy match was found. Re-read the file and retry with exact current content.',
      candidates,
    };
  }
  if (second && best.score - second.score < 0.08) {
    return {
      ok: false,
      code: 'AMBIGUOUS_MATCH',
      message:
        'Multiple similar fuzzy matches were found. Provide more surrounding lines.',
      candidates,
    };
  }

  return {
    ok: true,
    content: replaceLineWindow(content, best, input.newString),
    matched: 'fuzzy',
    replacements: 1,
  };
}

function allIndexes(content: string, needle: string) {
  const indexes: number[] = [];
  let index = content.indexOf(needle);
  while (index !== -1) {
    indexes.push(index);
    index = content.indexOf(needle, index + Math.max(needle.length, 1));
  }
  return indexes;
}

function replaceAt(
  content: string,
  index: number,
  length: number,
  replacement: string,
) {
  return `${content.slice(0, index)}${replacement}${content.slice(index + length)}`;
}

function normalizedWhitespaceMatch(content: string, needle: string) {
  const needleLines = needle.split('\n');
  const contentLines = content.split('\n');
  const needleNormalized = normalizeBlock(needleLines);
  const matches: Array<{ index: number; length: number }> = [];
  if (!needleNormalized) return matches;

  for (
    let start = 0;
    start <= contentLines.length - needleLines.length;
    start += 1
  ) {
    const window = contentLines.slice(start, start + needleLines.length);
    if (normalizeBlock(window) !== needleNormalized) continue;
    const index = lineStartIndex(content, start);
    matches.push({
      index,
      length: window.join('\n').length,
    });
  }
  return matches;
}

function normalizeBlock(lines: string[]) {
  return lines
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n')
    .trim();
}

function nearbyCandidates(content: string, needle: string) {
  const needleLines = needle.split('\n').filter((line) => line.trim());
  const contentLines = content.split('\n');
  const windowSize = Math.max(1, needle.split('\n').length);
  const candidates: ReplaceCandidate[] = [];

  for (let start = 0; start < contentLines.length; start += 1) {
    const window = contentLines.slice(start, start + windowSize);
    const score = similarity(
      normalizeBlock(window),
      normalizeBlock(needleLines),
    );
    if (score < 0.45) continue;
    candidates.push({
      startLine: start + 1,
      endLine: start + window.length,
      score,
      preview: window.join('\n').slice(0, 600),
    });
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}

function candidateFromIndex(
  content: string,
  index: number,
  length: number,
  score: number,
): ReplaceCandidate {
  const before = content.slice(0, index);
  const startLine = before.split('\n').length;
  const preview = content.slice(index, index + length);
  const endLine = startLine + Math.max(0, preview.split('\n').length - 1);
  return {
    startLine,
    endLine,
    score,
    preview: preview.slice(0, 600),
  };
}

function lineStartIndex(content: string, lineIndex: number) {
  if (lineIndex <= 0) return 0;
  let index = 0;
  for (let i = 0; i < lineIndex; i += 1) {
    const next = content.indexOf('\n', index);
    if (next === -1) return content.length;
    index = next + 1;
  }
  return index;
}

function replaceLineWindow(
  content: string,
  candidate: ReplaceCandidate,
  replacement: string,
) {
  const lines = content.split('\n');
  const start = candidate.startLine - 1;
  const deleteCount = candidate.endLine - candidate.startLine + 1;
  lines.splice(start, deleteCount, ...replacement.split('\n'));
  return lines.join('\n');
}

function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  const total = new Set([...aTokens, ...bTokens]).size;
  return total === 0 ? 0 : shared / total;
}
