import { normalizeRepoRelativePath, RepoPathPolicyError } from './path-safety';

export type PatchLine =
  | { kind: 'context'; text: string }
  | { kind: 'remove'; text: string }
  | { kind: 'add'; text: string };

export type PatchHunk = {
  contextHint?: string;
  lines: PatchLine[];
};

export type PatchOperation =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'update'; path: string; hunks: PatchHunk[] }
  | { type: 'delete'; path: string }
  | { type: 'move'; from: string; to: string; hunks: PatchHunk[] };

export type ParsedPatch = {
  operations: PatchOperation[];
};

export class PatchParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'PatchParseError';
    this.line = line;
  }
}

type MutableOperation =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'update'; path: string; hunks: PatchHunk[] }
  | { type: 'delete'; path: string }
  | { type: 'move'; from: string; to: string; hunks: PatchHunk[] };

export function parseV4APatch(source: string): ParsedPatch {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const operations: MutableOperation[] = [];
  let current: MutableOperation | undefined;
  let currentHunk: PatchHunk | undefined;

  const finishHunk = () => {
    if (!currentHunk || !current) return;
    if (current.type === 'update' || current.type === 'move') {
      current.hunks.push(currentHunk);
    }
    currentHunk = undefined;
  };
  const finishOperation = () => {
    finishHunk();
    current = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    if (line === '*** Begin Patch' || line === '*** End Patch') {
      finishOperation();
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      finishOperation();
      current = {
        type: 'add',
        path: parsePath(line.slice('*** Add File: '.length), lineNumber),
        lines: [],
      };
      operations.push(current);
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      finishOperation();
      current = {
        type: 'update',
        path: parsePath(line.slice('*** Update File: '.length), lineNumber),
        hunks: [],
      };
      operations.push(current);
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      finishOperation();
      current = {
        type: 'delete',
        path: parsePath(line.slice('*** Delete File: '.length), lineNumber),
      };
      operations.push(current);
      finishOperation();
      continue;
    }

    if (line.startsWith('*** Move File: ')) {
      finishOperation();
      const body = line.slice('*** Move File: '.length);
      const [from, to] = body.split(/\s+->\s+/);
      if (!from || !to) {
        throw new PatchParseError(
          'Move File requires "old -> new" paths.',
          lineNumber,
        );
      }
      current = {
        type: 'move',
        from: parsePath(from, lineNumber),
        to: parsePath(to, lineNumber),
        hunks: [],
      };
      operations.push(current);
      continue;
    }

    if (line.startsWith('@@')) {
      if (!current || (current.type !== 'update' && current.type !== 'move')) {
        throw new PatchParseError(
          'Hunk header found outside update or move operation.',
          lineNumber,
        );
      }
      finishHunk();
      const contextHint = line
        .replace(/^@@\s?/, '')
        .replace(/\s?@@$/, '')
        .trim();
      currentHunk = {
        contextHint: contextHint || undefined,
        lines: [],
      };
      continue;
    }

    if (!current) {
      if (line.trim() === '') continue;
      throw new PatchParseError(
        `Unexpected patch content: ${line}`,
        lineNumber,
      );
    }

    if (current.type === 'add') {
      if (line.startsWith('+')) {
        current.lines.push(line.slice(1));
        continue;
      }
      if (line === '') {
        current.lines.push('');
        continue;
      }
      throw new PatchParseError(
        'Add File lines must start with "+".',
        lineNumber,
      );
    }

    if (current.type === 'delete') {
      if (line.trim() === '') continue;
      throw new PatchParseError(
        'Delete File operations cannot contain hunk lines.',
        lineNumber,
      );
    }

    if (!currentHunk) {
      if (line.trim() === '') continue;
      currentHunk = { lines: [] };
    }

    const prefix = line[0];
    if (prefix === ' ') {
      currentHunk.lines.push({ kind: 'context', text: line.slice(1) });
    } else if (prefix === '-') {
      currentHunk.lines.push({ kind: 'remove', text: line.slice(1) });
    } else if (prefix === '+') {
      currentHunk.lines.push({ kind: 'add', text: line.slice(1) });
    } else {
      throw new PatchParseError(
        'Patch hunk lines must start with space, "-", or "+".',
        lineNumber,
      );
    }
  }

  finishOperation();
  if (operations.length === 0) {
    throw new PatchParseError('Patch did not contain any file operations.', 1);
  }
  for (const operation of operations) {
    if (operation.type === 'update' && operation.hunks.length === 0) {
      throw new PatchParseError(
        `Update File ${operation.path} has no hunks.`,
        1,
      );
    }
  }
  return { operations };
}

function parsePath(path: string, line: number) {
  try {
    return normalizeRepoRelativePath(path);
  } catch (error) {
    if (error instanceof RepoPathPolicyError) {
      throw new PatchParseError(error.message, line);
    }
    throw error;
  }
}
