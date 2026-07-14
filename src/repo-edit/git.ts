import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecFile } from '../lib/exec';
import type { DiffSummary } from './schemas';

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
  previousPath?: string | null;
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

export type GitPushResult = {
  remote: string;
  branch: string;
  force: boolean;
  stdout: string;
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

export async function gitChangedPaths(repoRoot: string) {
  const porcelain = await git(repoRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const entries = porcelain.split('\u0000');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const source = entries[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

export async function gitStagedPaths(repoRoot: string) {
  const output = await git(repoRoot, [
    'diff',
    '--cached',
    '--name-status',
    '--find-renames',
    '-z',
  ]);
  const entries = output.split('\u0000');
  const paths: string[] = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    if (!status) continue;
    const path = entries[index++];
    if (path) paths.push(path);
    if (status.startsWith('R') || status.startsWith('C')) {
      const destination = entries[index++];
      if (destination) paths.push(destination);
    }
  }
  return [...new Set(paths)];
}

export async function gitCurrentSha(repoRoot: string) {
  return (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
}

export async function gitDiff(
  repoRoot: string,
  input: {
    base?: string;
    head?: string;
    paths?: string[];
    includePatch?: boolean;
    maxPatchBytes?: number;
  } = {},
): Promise<RepoDiffResult> {
  const base = validateRef(input.base ?? 'HEAD');
  const head = input.head ? validateRef(input.head) : undefined;
  const pathspec = validatePathspec(input.paths);
  const refs = head ? [base, head] : [base];
  const [nameStatus, numstat] = await Promise.all([
    git(repoRoot, [
      'diff',
      '--name-status',
      '--find-renames',
      '-z',
      ...refs,
      '--',
      ...pathspec,
    ]),
    git(repoRoot, [
      'diff',
      '--numstat',
      '--find-renames',
      '-z',
      ...refs,
      '--',
      ...pathspec,
    ]),
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
      const status = statuses.get(path);
      const patch = input.includePatch
        ? await filePatch(
            repoRoot,
            base,
            path,
            input.maxPatchBytes,
            head,
            status?.previousPath ?? null,
          )
        : undefined;
      return {
        path,
        previousPath: status?.previousPath ?? null,
        status: status?.status ?? 'M',
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
        generatedLike: generatedLike(path),
        patch: patch?.patch,
        truncated: patch?.truncated,
      };
    }),
  );
  const untrackedFiles = head ? [] : await listUntracked(repoRoot, pathspec);
  const files = [
    ...trackedFiles,
    ...(await Promise.all(
      untrackedFiles.map(async (path) => {
        const additions = await countTextLines(join(repoRoot, path));
        const patch = input.includePatch
          ? await untrackedFilePatch(repoRoot, path, input.maxPatchBytes)
          : undefined;
        return {
          path,
          previousPath: null,
          status: 'untracked',
          additions,
          deletions: 0,
          binary: additions === 0,
          generatedLike: generatedLike(path),
          patch: patch?.patch,
          truncated: patch?.truncated ?? false,
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

async function untrackedFilePatch(
  repoRoot: string,
  path: string,
  maxBytes = 32 * 1024,
) {
  const buffer = await readFile(join(repoRoot, path)).catch(() =>
    Buffer.alloc(0),
  );
  if (buffer.includes(0)) {
    return {
      patch: `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`,
      truncated: false,
    };
  }

  const text = buffer.toString('utf8');
  const lines =
    text.length === 0
      ? []
      : text.endsWith('\n')
        ? text.slice(0, -1).split('\n')
        : text.split('\n');
  const missingFinalNewline = text.length > 0 && !text.endsWith('\n');
  const patchLines = [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
  if (missingFinalNewline) {
    patchLines.push('\\ No newline at end of file');
  }
  const patch = `${patchLines.join('\n')}\n`;
  const limit = Math.max(1, maxBytes);
  if (Buffer.byteLength(patch, 'utf8') <= limit) {
    return { patch, truncated: false };
  }
  return {
    patch: patch.slice(0, limit),
    truncated: true,
  };
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

export async function gitCommitPaths(
  repoRoot: string,
  message: string,
  paths: string[],
): Promise<GitCommitResult> {
  if (message.includes('\u0000')) {
    throw Object.assign(new Error('Invalid git commit message.'), {
      code: 'GIT_ERROR',
    });
  }
  const pathspec = validatePathspec(paths);
  if (pathspec.length === 0) {
    return {
      committed: false,
      sha: null,
      message: 'No paths supplied for commit.',
    };
  }

  const before = await git(repoRoot, [
    'status',
    '--porcelain=v1',
    '--',
    ...pathspec,
  ]);
  if (!before.trim()) {
    return {
      committed: false,
      sha: null,
      message: 'No worktree changes to commit.',
    };
  }

  await git(repoRoot, ['add', '-A', '--', ...pathspec]);
  const staged = await git(repoRoot, [
    'diff',
    '--cached',
    '--name-only',
    '--',
    ...pathspec,
  ]);
  if (!staged.trim()) {
    return {
      committed: false,
      sha: null,
      message: 'No staged changes to commit.',
    };
  }

  await git(repoRoot, ['commit', '--only', '-m', message, '--', ...pathspec]);
  const sha = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  return {
    committed: true,
    sha,
    message: `Committed ${sha}.`,
  };
}

export async function gitPushHead(
  repoRoot: string,
  input: { remote: string; branch: string; force?: boolean },
): Promise<GitPushResult> {
  const remote = validateRemote(input.remote);
  const branch = validateRef(input.branch);
  const refspec = `${input.force ? '+' : ''}HEAD:refs/heads/${branch}`;
  const stdout = await git(repoRoot, ['push', remote, refspec]);
  return {
    remote,
    branch,
    force: Boolean(input.force),
    stdout,
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
  head?: string,
  previousPath?: string | null,
) {
  const refs = head ? [base, head] : [base];
  const paths =
    previousPath && previousPath !== path ? [previousPath, path] : [path];
  const patch = await git(repoRoot, [
    'diff',
    '--no-color',
    '--find-renames',
    ...refs,
    '--',
    ...paths,
  ]);
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) {
    return { patch, truncated: false };
  }
  return { patch: patch.slice(0, maxBytes), truncated: true };
}

function parseNameStatus(output: string) {
  if (output.includes('\0')) return parseNameStatusZ(output);
  const statuses = new Map<
    string,
    { status: string; previousPath: string | null }
  >();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split('\t');
    const path = paths.at(-1);
    if (!status || !path) continue;
    statuses.set(path, {
      status: normalizeNameStatus(status),
      previousPath:
        status.startsWith('R') || status.startsWith('C')
          ? (paths[0] ?? null)
          : null,
    });
  }
  return statuses;
}

function parseNameStatusZ(output: string) {
  const statuses = new Map<
    string,
    { status: string; previousPath: string | null }
  >();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++] ?? null;
      const path = fields[index++];
      if (path) {
        statuses.set(path, {
          status: normalizeNameStatus(status),
          previousPath,
        });
      }
      continue;
    }
    const path = fields[index++];
    if (path) {
      statuses.set(path, {
        status: normalizeNameStatus(status),
        previousPath: null,
      });
    }
  }
  return statuses;
}

function normalizeNameStatus(status: string) {
  if (status.startsWith('R')) return 'R';
  if (status.startsWith('C')) return 'C';
  return status;
}

function parseNumstat(output: string) {
  if (output.includes('\0')) return parseNumstatZ(output);
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

function parseNumstatZ(output: string) {
  const stats = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  const fields = output.split('\0');
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

function validateRemote(remote: string) {
  const trimmed = remote.trim();
  if (!trimmed || trimmed.startsWith('-') || trimmed.includes('\u0000')) {
    throw Object.assign(new Error(`Invalid git remote: ${remote}`), {
      code: 'GIT_ERROR',
    });
  }
  return trimmed;
}

async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  const { stdout } = await runExecFile('git', args, {
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
