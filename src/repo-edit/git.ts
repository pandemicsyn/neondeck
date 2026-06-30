import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DiffSummary } from './schemas';

const execFileAsync = promisify(execFile);

export type RepoGitStatus = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: Array<{ path: string; status: string }>;
};

export type RepoDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  generatedLike: boolean;
  patch?: string;
  truncated?: boolean;
};

export type RepoDiffResult = {
  base: string;
  files: RepoDiffFile[];
  summary: DiffSummary;
};

export type ApplyPatchResult = {
  ok: boolean;
  message: string;
  conflicts: Array<{ file?: string; reason: string }>;
};

export type GitCommitResult = {
  committed: boolean;
  sha: string | null;
  message: string;
};

export async function gitStatus(repoRoot: string): Promise<RepoGitStatus> {
  const [branch, upstream, porcelain] = await Promise.all([
    git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) =>
      out.trim(),
    ),
    git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
      .then((out) => out.trim() || undefined)
      .catch(() => undefined),
    git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const aheadBehind = upstream
    ? await git(repoRoot, [
        'rev-list',
        '--left-right',
        '--count',
        `${upstream}...HEAD`,
      ])
        .then((out) => {
          const [behind, ahead] = out.trim().split(/\s+/).map(Number);
          return { ahead: ahead || 0, behind: behind || 0 };
        })
        .catch(() => ({ ahead: 0, behind: 0 }))
    : { ahead: 0, behind: 0 };
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || 'M',
      path: line.slice(3).trim(),
    }));

  return {
    branch,
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    clean: files.length === 0,
    files,
  };
}

export async function gitDiff(
  repoRoot: string,
  input: {
    base?: string;
    paths?: string[];
    includePatch?: boolean;
    maxPatchBytes?: number;
  } = {},
): Promise<RepoDiffResult> {
  const base = validateRef(input.base ?? 'HEAD');
  const pathspec = validatePathspec(input.paths);
  const [nameStatus, numstat] = await Promise.all([
    git(repoRoot, ['diff', '--name-status', base, '--', ...pathspec]),
    git(repoRoot, ['diff', '--numstat', base, '--', ...pathspec]),
  ]);
  const statuses = parseNameStatus(nameStatus);
  const numstats = parseNumstat(numstat);
  const trackedFiles = await Promise.all(
    [...new Set([...statuses.keys(), ...numstats.keys()])].map(async (path) => {
      const stats = numstats.get(path) ?? {
        additions: 0,
        deletions: 0,
        binary: false,
      };
      const patch = input.includePatch
        ? await filePatch(repoRoot, base, path, input.maxPatchBytes)
        : undefined;
      return {
        path,
        status: statuses.get(path) ?? 'M',
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
        generatedLike: generatedLike(path),
        patch: patch?.patch,
        truncated: patch?.truncated,
      };
    }),
  );
  const untrackedFiles = await listUntracked(repoRoot, pathspec);
  const files = [
    ...trackedFiles,
    ...(await Promise.all(
      untrackedFiles.map(async (path) => {
        const additions = await countTextLines(join(repoRoot, path));
        return {
          path,
          status: 'untracked',
          additions,
          deletions: 0,
          binary: additions === 0,
          generatedLike: generatedLike(path),
          patch: undefined,
          truncated: false,
        };
      }),
    )),
  ];

  return {
    base,
    files,
    summary: summarizeDiff(files),
  };
}

export async function gitCommitAll(
  repoRoot: string,
  message: string,
): Promise<GitCommitResult> {
  await git(repoRoot, ['add', '-A']);
  const status = await gitStatus(repoRoot);
  if (status.clean) {
    return {
      committed: false,
      sha: null,
      message: 'No changes were available to commit.',
    };
  }
  await git(repoRoot, ['commit', '-m', message]);
  const sha = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  return {
    committed: true,
    sha,
    message: `Committed ${sha}.`,
  };
}

async function listUntracked(repoRoot: string, pathspec: string[]) {
  const output = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...(pathspec.length ? pathspec : ['.']),
  ]);
  return output.split('\n').filter(Boolean);
}

async function countTextLines(path: string) {
  const buffer = await readFile(path).catch(() => Buffer.alloc(0));
  if (buffer.includes(0)) return 0;
  const text = buffer.toString('utf8');
  return text ? text.split('\n').filter((line) => line.length > 0).length : 0;
}

export async function buildWorktreePatch(
  repoRoot: string,
  baseRef: string,
  selectedFiles?: string[],
) {
  const tmp = await mkdtemp(join(tmpdir(), 'neondeck-apply-'));
  const index = join(tmp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const pathspec = validatePathspec(selectedFiles);

  try {
    const base = (await git(repoRoot, ['merge-base', 'HEAD', baseRef])).trim();
    const baseTree = (
      await git(repoRoot, ['rev-parse', `${base}^{tree}`])
    ).trim();
    await git(repoRoot, ['read-tree', 'HEAD'], { env });
    await git(
      repoRoot,
      ['add', '-A', '--', ...(pathspec.length ? pathspec : ['.'])],
      {
        env,
      },
    );
    const tree = (await git(repoRoot, ['write-tree'], { env })).trim();
    return git(repoRoot, [
      'diff',
      '--binary',
      '--full-index',
      '--find-renames',
      '--no-color',
      baseTree,
      tree,
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function checkApplyUnifiedPatch(
  repoRoot: string,
  patch: string,
): Promise<ApplyPatchResult> {
  if (!patch.trim()) {
    return { ok: true, message: 'No changes to apply', conflicts: [] };
  }

  const result = await gitWithStdin(
    repoRoot,
    ['apply', '--3way', '--check', '--whitespace=nowarn', '-'],
    patch,
  );
  if (result.code === 0) {
    return { ok: true, message: 'Patch applies cleanly', conflicts: [] };
  }

  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  return {
    ok: false,
    message: output.trim() || 'Patch does not apply cleanly',
    conflicts: parseApplyConflicts(output),
  };
}

export async function applyUnifiedPatch(
  repoRoot: string,
  patch: string,
): Promise<ApplyPatchResult> {
  if (!patch.trim()) {
    return { ok: true, message: 'No changes to apply', conflicts: [] };
  }

  const result = await gitWithStdin(
    repoRoot,
    ['apply', '--3way', '--whitespace=nowarn', '-'],
    patch,
  );
  if (result.code === 0) {
    return { ok: true, message: 'Patch applied', conflicts: [] };
  }

  const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
  return {
    ok: false,
    message: output.trim() || 'Failed to apply patch',
    conflicts: parseApplyConflicts(output),
  };
}

export async function unifiedDiff(
  repoRoot: string,
  relativePath: string,
  before: string,
  after: string,
) {
  const oldLabel = `a/${relativePath}`;
  const newLabel = `b/${relativePath}`;
  const result = await gitWithStdin(
    repoRoot,
    ['diff', '--no-index', '--no-color', '--', oldLabel, newLabel],
    '',
    {
      fakeNoIndex: { before, after, oldLabel, newLabel },
    },
  );
  return result.stdout || fallbackDiff(relativePath, before, after);
}

export function summarizeDiff(
  files: Array<{ additions: number; deletions: number; binary: boolean }>,
): DiffSummary {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    binaryFiles: files.filter((file) => file.binary).length,
  };
}

export function countDiffLines(diff: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions, binary: false };
}

async function filePatch(
  repoRoot: string,
  base: string,
  path: string,
  maxBytes = 64 * 1024,
) {
  const patch = await git(repoRoot, ['diff', '--no-color', base, '--', path]);
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) {
    return { patch, truncated: false };
  }
  return { patch: patch.slice(0, maxBytes), truncated: true };
}

function parseNameStatus(output: string) {
  const statuses = new Map<string, string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split(/\s+/);
    const path = paths.at(-1);
    if (status && path) statuses.set(path, status);
  }
  return statuses;
}

function parseNumstat(output: string) {
  const stats = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [additions, deletions, ...paths] = line.split(/\s+/);
    const path = paths.join(' ');
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

function validateRef(ref: string) {
  if (
    ref.startsWith('-') ||
    ref.includes('\u0000') ||
    /[\s\\~^:?*[\]]/.test(ref)
  ) {
    throw Object.assign(new Error(`Invalid git ref: ${ref}`), {
      code: 'GIT_ERROR',
    });
  }
  return ref;
}

function validatePathspec(paths?: string[]) {
  if (!paths) return [];
  const validated: string[] = [];
  for (const rawPath of paths) {
    const path = rawPath.trim();
    if (
      !path ||
      path.startsWith('/') ||
      path.startsWith('-') ||
      path.split(/[\\/]/).includes('..')
    ) {
      throw Object.assign(new Error(`Invalid git pathspec: ${rawPath}`), {
        code: 'PATH_OUTSIDE_WORKSPACE',
        path: rawPath,
      });
    }
    validated.push(path);
  }
  return validated;
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: options.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function gitWithStdin(
  cwd: string,
  args: string[],
  stdin: string,
  options: {
    fakeNoIndex?: {
      before: string;
      after: string;
      oldLabel: string;
      newLabel: string;
    };
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (options.fakeNoIndex) {
    return Promise.resolve({
      code: options.fakeNoIndex.before === options.fakeNoIndex.after ? 0 : 1,
      stdout: fallbackDiff(
        options.fakeNoIndex.oldLabel.replace(/^a\//, ''),
        options.fakeNoIndex.before,
        options.fakeNoIndex.after,
      ),
      stderr: '',
    });
  }

  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function parseApplyConflicts(output: string) {
  const conflicts: Array<{ file?: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line) continue;

    const patchFailed = /^error:\s+patch failed:\s+(.+?):\d+$/i.exec(line);
    if (patchFailed) {
      addConflict(conflicts, seen, patchFailed[1], 'patch failed');
      continue;
    }

    const fileReason =
      /^error:\s+(.+?):\s+(does not match index|patch does not apply|cannot read the current contents.*)$/i.exec(
        line,
      );
    if (fileReason) {
      addConflict(conflicts, seen, fileReason[1], fileReason[2] ?? 'conflict');
    }
  }

  return conflicts.length
    ? conflicts
    : [{ reason: output.trim() || 'conflict' }];
}

function addConflict(
  conflicts: Array<{ file?: string; reason: string }>,
  seen: Set<string>,
  file: string | undefined,
  reason: string,
) {
  const key = `${file ?? ''}:${reason}`;
  if (seen.has(key)) return;
  seen.add(key);
  conflicts.push({ file, reason });
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

function fallbackDiff(path: string, before: string, after: string) {
  if (before === after) return '';
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...before.split('\n').map((line) => `-${line}`),
    ...after.split('\n').map((line) => `+${line}`),
    '',
  ].join('\n');
}
