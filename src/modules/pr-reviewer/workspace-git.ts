import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  runUnattendedGit,
  unattendedGitEnv,
  unattendedGitTimeoutMs,
} from '../../lib/git';

type ChangedFile = {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'renamed' | 'copied' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  binary: boolean;
  generatedLike: boolean;
  kind: 'production' | 'test' | 'documentation';
};

type DiffHunk = {
  header: string;
  context: string | null;
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
};

type BlameLine = {
  commit: string;
  originalLine: number;
  line: number;
  author: string;
  authoredAt: string | null;
  summary: string;
  text: string;
  textTruncated: boolean;
};

type TargetedDiffLine = {
  kind: 'addition' | 'deletion' | 'context';
  leftLine: number | null;
  rightLine: number | null;
  rightPosition: number;
  text: string;
  textTruncated: boolean;
};

export async function readWorkspaceChangedFiles(
  cwd: string,
  mergeBase: string,
  headSha: string,
  signal?: AbortSignal,
) {
  const [nameStatus, numstat] = await Promise.all([
    runWorkspaceGit(
      cwd,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '--find-renames',
        '-z',
        mergeBase,
        headSha,
        '--',
      ],
      16 * 1024 * 1024,
      signal,
    ),
    runWorkspaceGit(
      cwd,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '--find-renames',
        '-z',
        mergeBase,
        headSha,
        '--',
      ],
      16 * 1024 * 1024,
      signal,
    ),
  ]);
  const statuses = parseChangedFileStatuses(nameStatus);
  const stats = parseChangedFileStats(numstat);
  const paths = [...new Set([...statuses.keys(), ...stats.keys()])].sort();
  const files: ChangedFile[] = paths.map((path) => {
    const status = statuses.get(path);
    const counts = stats.get(path) ?? {
      additions: 0,
      deletions: 0,
      binary: false,
    };
    return {
      path,
      previousPath: status?.previousPath ?? null,
      status: normalizeChangedFileStatus(status?.status ?? 'M'),
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      binary: counts.binary,
      generatedLike: generatedLike(path),
      kind: reviewFileKind(path),
    };
  });
  return {
    files,
    summary: {
      files: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      binaryFiles: files.filter((file) => file.binary).length,
      productionFiles: files.filter((file) => file.kind === 'production')
        .length,
      testFiles: files.filter((file) => file.kind === 'test').length,
      documentationFiles: files.filter((file) => file.kind === 'documentation')
        .length,
    },
  };
}

export async function resolveWorkspaceDiffPathspec(
  cwd: string,
  mergeBase: string,
  headSha: string,
  path: string,
  signal?: AbortSignal,
) {
  const output = await runWorkspaceGit(
    cwd,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--find-renames',
      mergeBase,
      headSha,
      '--',
    ],
    16 * 1024 * 1024,
    signal,
  );
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++] ?? '';
      const nextPath = fields[index++] ?? '';
      if (nextPath === path) return [previousPath, nextPath].filter(Boolean);
      continue;
    }
    const changedPath = fields[index++] ?? '';
    if (changedPath === path) return [path];
  }
  return [path];
}

export async function streamWorkspaceDiffHunks(
  cwd: string,
  args: string[],
  limit: number,
  signal?: AbortSignal,
) {
  const hunks: DiffHunk[] = [];
  let totalHunks = 0;
  const handleLine = (line: string) => {
    const match = line.match(
      /^@@ -(?<left>\d+)(?:,(?<leftCount>\d+))? \+(?<right>\d+)(?:,(?<rightCount>\d+))? @@(?<context>.*)$/,
    );
    if (!match?.groups) return;
    totalHunks += 1;
    if (hunks.length >= limit) return;
    const boundedHeader = boundWorkspaceGitText(line, 2 * 1024);
    const boundedContext = boundWorkspaceGitText(
      match.groups.context.trim(),
      1_000,
    );
    hunks.push({
      header: boundedHeader.text,
      context: boundedContext.text || null,
      leftStart: Number(match.groups.left),
      leftCount: Number(match.groups.leftCount ?? 1),
      rightStart: Number(match.groups.right),
      rightCount: Number(match.groups.rightCount ?? 1),
    });
  };
  await streamGitLines(cwd, args, 2 * 1024 + 1, handleLine, signal);
  return { hunks, totalHunks, truncated: totalHunks > hunks.length };
}

export async function streamWorkspaceDiffLinesAroundRightLine(
  cwd: string,
  args: string[],
  targetRightLine: number,
  contextLines: number,
  signal?: AbortSignal,
) {
  const lines: TargetedDiffLine[] = [];
  let responseTruncated = false;
  let targetChanged = false;
  let leftLine = 0;
  let rightLine = 0;
  let inHunk = false;

  const retain = (line: TargetedDiffLine) => {
    if (Math.abs(line.rightPosition - targetRightLine) > contextLines) return;
    if (line.textTruncated) responseTruncated = true;
    if (lines.length >= 500) {
      responseTruncated = true;
      return;
    }
    lines.push(line);
  };

  const handleLine = (text: string, sourceTruncated: boolean) => {
    const header = text.match(
      /^@@ -(?<left>\d+)(?:,\d+)? \+(?<right>\d+)(?:,\d+)? @@/,
    );
    if (header?.groups) {
      leftLine = Number(header.groups.left);
      rightLine = Number(header.groups.right);
      inHunk = true;
      return;
    }
    if (!inHunk || text.startsWith('\\ No newline')) return;
    if (text.startsWith('+')) {
      const bounded = boundWorkspaceGitText(text.slice(1), 8 * 1024);
      if (rightLine === targetRightLine) targetChanged = true;
      retain({
        kind: 'addition',
        leftLine: null,
        rightLine,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      rightLine += 1;
      return;
    }
    if (text.startsWith('-')) {
      const bounded = boundWorkspaceGitText(text.slice(1), 8 * 1024);
      retain({
        kind: 'deletion',
        leftLine,
        rightLine: null,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      leftLine += 1;
      return;
    }
    if (text.startsWith(' ')) {
      const bounded = boundWorkspaceGitText(text.slice(1), 8 * 1024);
      retain({
        kind: 'context',
        leftLine,
        rightLine,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      leftLine += 1;
      rightLine += 1;
    }
  };

  await streamGitLines(cwd, args, 8 * 1024 + 1, handleLine, signal);
  return { lines, targetChanged, truncated: responseTruncated };
}

export function parseWorkspaceHistory(output: string) {
  return output
    .split('\u001e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', authoredAt = '', author = '', ...subjectParts] =
        record.split('\u001f');
      return {
        sha,
        authoredAt,
        author: boundWorkspaceGitText(author, 500).text,
        subject: boundWorkspaceGitText(subjectParts.join('\u001f'), 2_000).text,
      };
    });
}

export function parseWorkspaceBlame(output: string) {
  const lines: BlameLine[] = [];
  let current: Omit<BlameLine, 'text' | 'textTruncated'> | undefined;
  for (const rawLine of output.split('\n')) {
    const header = rawLine.match(
      /^(?<commit>[0-9a-f]{40}) (?<original>\d+) (?<line>\d+)(?: \d+)?$/i,
    );
    if (header?.groups) {
      current = {
        commit: header.groups.commit,
        originalLine: Number(header.groups.original),
        line: Number(header.groups.line),
        author: '',
        authoredAt: null,
        summary: '',
      };
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith('author ')) {
      current.author = boundWorkspaceGitText(
        rawLine.slice('author '.length),
        500,
      ).text;
      continue;
    }
    if (rawLine.startsWith('author-time ')) {
      const seconds = Number(rawLine.slice('author-time '.length));
      current.authoredAt = Number.isFinite(seconds)
        ? new Date(seconds * 1_000).toISOString()
        : null;
      continue;
    }
    if (rawLine.startsWith('summary ')) {
      current.summary = boundWorkspaceGitText(
        rawLine.slice('summary '.length),
        2_000,
      ).text;
      continue;
    }
    if (rawLine.startsWith('\t')) {
      const text = boundWorkspaceGitText(rawLine.slice(1), 8 * 1024);
      lines.push({
        ...current,
        text: text.text,
        textTruncated: text.truncated,
      });
      current = undefined;
    }
  }
  return lines;
}

export function literalWorkspacePathspec(value: string) {
  return `:(literal)${value}`;
}

export function boundWorkspaceGitText(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return { text: value, truncated: false };
  return {
    text: Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

export async function runWorkspaceGit(
  cwd: string,
  args: string[],
  maxBuffer = 2 * 1024 * 1024,
  signal?: AbortSignal,
) {
  return runUnattendedGit(cwd, args, { maxBuffer, signal });
}

function parseChangedFileStatuses(output: string) {
  const statuses = new Map<
    string,
    { status: string; previousPath: string | null }
  >();
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++] ?? null;
      const path = fields[index++];
      if (path) statuses.set(path, { status, previousPath });
      continue;
    }
    const path = fields[index++];
    if (path) statuses.set(path, { status, previousPath: null });
  }
  return statuses;
}

function parseChangedFileStats(output: string) {
  const stats = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header) continue;
    const [additions, deletions, pathFromHeader = ''] = header.split('\t');
    let path = pathFromHeader;
    if (!pathFromHeader) {
      index += 1;
      path = fields[index++] ?? '';
    }
    if (!path) continue;
    const binary = additions === '-' || deletions === '-';
    stats.set(path, {
      additions: binary ? 0 : Number(additions ?? 0),
      deletions: binary ? 0 : Number(deletions ?? 0),
      binary,
    });
  }
  return stats;
}

function normalizeChangedFileStatus(status: string): ChangedFile['status'] {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'removed';
  if (status.startsWith('R')) return 'renamed';
  if (status.startsWith('C')) return 'copied';
  return 'modified';
}

function generatedLike(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.endsWith('.lock') ||
    [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'Cargo.lock',
    ].includes(name)
  );
}

function reviewFileKind(path: string): ChangedFile['kind'] {
  const lower = path.toLowerCase();
  if (
    /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(lower) ||
    /\.(?:test|spec)\.[^/]+$/.test(lower)
  ) {
    return 'test';
  }
  if (
    lower.startsWith('docs/') ||
    lower.startsWith('.specs/') ||
    /\.(?:md|mdx|rst|adoc)$/.test(lower)
  ) {
    return 'documentation';
  }
  return 'production';
}

function streamGitLines(
  cwd: string,
  args: string[],
  maxLineCharacters: number,
  onLine: (line: string, truncated: boolean) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: unattendedGitEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let terminationError: Error | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let decoderEnded = false;
    const decoder = new StringDecoder('utf8');
    let retained = '';
    let truncated = false;

    const append = (segment: string) => {
      const available = Math.max(0, maxLineCharacters - retained.length);
      if (available > 0) retained += segment.slice(0, available);
      if (segment.length > available) truncated = true;
    };
    const emit = () => {
      const line = retained.endsWith('\r') ? retained.slice(0, -1) : retained;
      onLine(line, truncated);
      retained = '';
      truncated = false;
    };
    const consume = (value: string) => {
      let offset = 0;
      while (offset < value.length) {
        const newline = value.indexOf('\n', offset);
        if (newline < 0) {
          append(value.slice(offset));
          return;
        }
        append(value.slice(offset, newline));
        emit();
        offset = newline + 1;
      }
    };
    const endDecoder = () => {
      if (decoderEnded) return;
      decoderEnded = true;
      consume(decoder.end());
      if (retained || truncated) emit();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      terminateStreamedGit(child.pid, 'SIGTERM');
      killTimeout = setTimeout(() => {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(error);
      }, 250);
    };
    const abort = () => {
      const reason = signal?.reason;
      terminate(
        reason instanceof Error
          ? reason
          : new DOMException('Git operation aborted.', 'AbortError'),
      );
    };
    const timeout = setTimeout(
      () =>
        terminate(
          new Error(
            `git ${args.join(' ')} timed out after ${unattendedGitTimeoutMs}ms.`,
          ),
        ),
      unattendedGitTimeoutMs,
    );

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      try {
        consume(decoder.write(chunk));
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdout.once('end', () => {
      if (terminationError || settled) return;
      try {
        endDecoder();
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      stderr = boundWorkspaceGitText(
        `${stderr}${chunk.toString()}`,
        64 * 1024,
      ).text;
    });
    child.once('error', (error) => {
      if (terminationError) {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(terminationError);
        return;
      }
      finish(error);
    });
    child.once('close', (code, childSignal) => {
      if (terminationError) {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(terminationError);
        return;
      }
      try {
        endDecoder();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          stderr.trim() ||
            `git ${args.join(' ')} failed with ${childSignal ?? `code ${code}`}.`,
        ),
      );
    });
  });
}

function terminateStreamedGit(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    // The process may already have exited.
  }
}
