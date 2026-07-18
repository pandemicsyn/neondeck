import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitRepositorySeedOptions {
  initialBranch?: string;
  initialCommitMessage?: string;
  initialFiles: Record<string, string>;
  feature?: {
    branch?: string;
    commitMessage?: string;
    files: Record<string, string>;
  };
}

export interface SeededGitRepository {
  baseSha: string;
  featureSha: string | null;
  copyTo(destination: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function createSeededGitRepository(
  options: GitRepositorySeedOptions,
): Promise<SeededGitRepository> {
  const seedRoot = await mkdtemp(join(tmpdir(), 'neondeck-git-seed-'));
  const repository = join(seedRoot, 'repository');
  const initialBranch = options.initialBranch ?? 'main';

  await mkdir(repository, { recursive: true });
  await git(repository, ['init', '-b', initialBranch]);
  await git(repository, ['config', 'user.name', 'Neondeck Test']);
  await git(repository, ['config', 'user.email', 'neondeck@example.test']);
  await git(repository, ['config', 'commit.gpgsign', 'false']);
  await writeFiles(repository, options.initialFiles);
  await git(repository, ['add', '-A']);
  await git(repository, [
    'commit',
    '-m',
    options.initialCommitMessage ?? 'initial',
  ]);
  const baseSha = await gitOutput(repository, ['rev-parse', 'HEAD']);

  let featureSha: string | null = null;
  if (options.feature) {
    const featureBranch = options.feature.branch ?? 'feature';
    await git(repository, ['checkout', '-b', featureBranch]);
    await writeFiles(repository, options.feature.files);
    await git(repository, ['add', '-A']);
    await git(repository, [
      'commit',
      '-m',
      options.feature.commitMessage ?? 'feature',
    ]);
    featureSha = await gitOutput(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['checkout', initialBranch]);
  }

  return {
    baseSha,
    featureSha,
    async copyTo(destination) {
      await mkdir(dirname(destination), { recursive: true });
      await cp(repository, destination, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    },
    async dispose() {
      await rm(seedRoot, { recursive: true, force: true });
    },
  };
}

async function writeFiles(root: string, files: Record<string, string>) {
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }),
  );
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}
