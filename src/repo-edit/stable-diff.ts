import {
  reviewRevisionKey,
  type ReviewRevision,
} from '../../shared/review-source';
import { gitDiff, gitWorktreeRevision, type RepoDiffResult } from './git';

type DiffInput = NonNullable<Parameters<typeof gitDiff>[1]>;

export type StableDiffMetadataDependencies = {
  gitDiff?: typeof gitDiff;
  gitWorktreeRevision?: typeof gitWorktreeRevision;
};

export type StableDiffMetadataResult =
  | {
      stable: true;
      diff: RepoDiffResult;
      revision: ReviewRevision;
    }
  | {
      stable: false;
      revision: ReviewRevision;
    };

export async function readStableDiffMetadata(
  repoRoot: string,
  input: DiffInput,
  dependencies: StableDiffMetadataDependencies = {},
): Promise<StableDiffMetadataResult> {
  const readDiff = dependencies.gitDiff ?? gitDiff;
  const readRevision = dependencies.gitWorktreeRevision ?? gitWorktreeRevision;
  const readGeneration = async () => {
    const diff = await readDiff(repoRoot, input);
    const identityDiff = input.paths?.length
      ? await readDiff(repoRoot, {
          base: input.base,
          includePatch: false,
        })
      : diff;
    const revision = await readRevision(repoRoot, {
      base: identityDiff.base,
      files: identityDiff.files,
    });
    return { diff, identityDiff, revision };
  };

  const first = await readGeneration();
  const confirmed = await readGeneration();
  if (
    diffMetadataKey(first.diff) !== diffMetadataKey(confirmed.diff) ||
    diffMetadataKey(first.identityDiff) !==
      diffMetadataKey(confirmed.identityDiff) ||
    reviewRevisionKey(first.revision) !== reviewRevisionKey(confirmed.revision)
  ) {
    return { stable: false, revision: confirmed.revision };
  }
  return {
    stable: true,
    diff: confirmed.diff,
    revision: confirmed.revision,
  };
}

function diffMetadataKey(diff: RepoDiffResult) {
  return JSON.stringify({
    base: diff.base,
    files: diff.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      binary: file.binary,
      generatedLike: file.generatedLike,
      truncated: file.truncated ?? false,
    })),
    summary: diff.summary,
  });
}
