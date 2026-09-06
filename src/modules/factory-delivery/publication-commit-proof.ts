import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { sameDeliveryRevision } from './store';
import { commitConfiguration } from './publication-hooks';
import { recoveredCommit } from './publication-tree';
import { exists, object } from './publication-git-io';
import {
  hash,
  label,
  publicationCommitSchema,
  publicationWorkspaceSchema,
  publicationWorkspaceFrom,
  type PublicationWorkspace,
  type PublicationCommit,
} from './publication-contract';
const configurationSchema = v.strictObject({
  name: label,
  email: v.pipe(v.string(), v.email()),
  hooksPath: label,
  fingerprint: hash,
});
const intentSchema = v.strictObject({
  effectId: label,
  workspace: publicationWorkspaceSchema,
  configuration: configurationSchema,
});
const successSchema = v.strictObject({
  intentDigest: hash,
  commit: publicationCommitSchema,
});
type Configuration = v.InferOutput<typeof configurationSchema>;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(pipeline: DeliveryPipeline, workspace: PublicationWorkspace) {
  const effectId = `commit:${pipeline.revision.candidateDigest}`;
  const effect = pipeline.effects.find(
    (e) =>
      e.id === effectId &&
      e.kind === 'commit' &&
      sameDeliveryRevision(e.revision, pipeline.revision),
  );
  if (
    !effect ||
    effect.state === 'planned' ||
    workspace.pipelineId !== pipeline.pipelineId ||
    workspace.repoId !== pipeline.repoId ||
    workspace.treeSha !== pipeline.revision.treeSha
  )
    throw new Error(
      'Publication commit requires its exact started effect intent.',
    );
  return effectId;
}
function files(
  pipeline: DeliveryPipeline,
  workspace: PublicationWorkspace,
  paths: RuntimePaths,
) {
  const effectId = identity(pipeline, workspace);
  v.parse(hash, pipeline.pipelineId);
  const directory = join(paths.home, 'factory-delivery', pipeline.pipelineId);
  const key = digest(effectId);
  return {
    directory,
    effectId,
    intent: join(directory, `commit-intent-${key}.json`),
    success: join(directory, `commit-success-${key}.json`),
  };
}
async function readJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
    throw new Error('Invalid publication proof file.');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(32769);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 32768) throw new Error('Publication proof exceeds bound.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}
async function exclusive(path: string, value: unknown) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 32768)
    throw new Error('Publication proof exceeds bound.');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function canonicalDirectory(directory: string) {
  if (
    (await realpath(directory)) !== directory ||
    (await lstat(directory)).isSymbolicLink()
  )
    throw new Error('Publication proof directory is not canonical.');
}
/** Intent is exclusive and fsynced BEFORE Git. Existing intent never permits
 * running Git again: only a completed, validated host receipt can be recovered.
 */
export async function beginPublicationCommit(
  pipeline: DeliveryPipeline,
  input: PublicationWorkspace,
  paths: RuntimePaths,
  rawConfig: Configuration,
) {
  const workspace = v.parse(publicationWorkspaceSchema, input);
  const configuration = v.parse(configurationSchema, rawConfig);
  const locations = files(pipeline, workspace, paths);
  const expected = v.parse(intentSchema, {
    effectId: locations.effectId,
    workspace,
    configuration,
  });
  await mkdir(locations.directory, { recursive: true, mode: 0o700 });
  await canonicalDirectory(locations.directory);
  if (
    !(await exists(locations.intent)) &&
    (await object(workspace.root, 'HEAD', 'commit')) !==
      workspace.originalHeadSha
  )
    throw new Error(
      'Publication HEAD advanced without a proven commit intent.',
    );
  try {
    await exclusive(locations.intent, expected);
    return false;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
    const stored = v.parse(intentSchema, await readJson(locations.intent));
    if (digest(stored) !== digest(expected))
      throw new Error('Persisted commit configuration or intent changed.');
    return true;
  }
}
/** Only call after normal Git success and all configuration/tree/author checks. */
export async function writePublicationCommitSuccess(
  pipeline: DeliveryPipeline,
  commit: PublicationCommit,
  paths: RuntimePaths,
  configuration: Configuration,
) {
  const workspace = publicationWorkspaceFrom(commit);
  const locations = files(pipeline, workspace, paths);
  await canonicalDirectory(locations.directory);
  const intent = v.parse(intentSchema, await readJson(locations.intent));
  if (
    digest(intent) !==
    digest({ effectId: locations.effectId, workspace, configuration })
  )
    throw new Error('Commit intent changed before receipt.');
  await exclusive(
    locations.success,
    v.parse(successSchema, { intentDigest: digest(intent), commit }),
  );
}
/** Read-only recovery shared by the live commit path and restart observer.
 * Missing success receipt is uncertainty, even if tree/parent/message match.
 */
export async function readValidatedPublicationCommitReceipt(
  pipeline: DeliveryPipeline,
  input: PublicationWorkspace,
  paths: RuntimePaths,
): Promise<PublicationCommit | null> {
  const workspace = publicationWorkspaceFrom(input);
  const locations = files(pipeline, workspace, paths);
  if (!(await exists(locations.directory))) return absentCommit(workspace);
  await canonicalDirectory(locations.directory);
  if (!(await exists(locations.intent))) return absentCommit(workspace);
  const intent = v.parse(intentSchema, await readJson(locations.intent));
  if (
    intent.effectId !== locations.effectId ||
    digest(intent.workspace) !== digest(workspace) ||
    digest(intent.configuration) !==
      digest(await commitConfiguration(workspace))
  )
    throw new Error('Persisted commit configuration or intent changed.');
  if (!(await exists(locations.success)))
    throw new Error(
      'Publication commit outcome is uncertain: no validated hook-success receipt.',
    );
  const receipt = v.parse(successSchema, await readJson(locations.success));
  if (
    receipt.intentDigest !== digest(intent) ||
    digest(publicationWorkspaceFrom(receipt.commit)) !== digest(workspace)
  )
    throw new Error('Publication receipt does not match its intent.');
  const actual = await recoveredCommit(workspace);
  if (!actual || actual.publishedHeadSha !== receipt.commit.publishedHeadSha)
    throw new Error('Publication receipt commit changed.');
  return receipt.commit;
}

async function absentCommit(workspace: PublicationWorkspace): Promise<null> {
  if (
    (await object(workspace.root, 'HEAD', 'commit')) !==
    workspace.originalHeadSha
  )
    throw new Error(
      'Publication HEAD advanced without a validated hook-success receipt.',
    );
  return null;
}
