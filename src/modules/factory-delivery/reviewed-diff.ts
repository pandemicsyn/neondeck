import { deliveryEvidenceDisplayMaxBytes } from '../../../shared/factory-delivery-evidence';
import * as v from 'valibot';
import { reviewedDiffSchema } from '../../../shared/factory-delivery-api';
import type { RuntimePaths } from '../../runtime-home';
import { codingHandle, requireCodingRun } from '../factory';
import { hostGit, loadLocalManifest } from '../coding-runs';
import { requireDelivery } from './service-records';
import {
  settledEvidence,
  sameDeliveryRevision,
  publicationEvidenceFingerprint,
} from './delivery-aggregate';
import { isSensitiveProgressDiffPath } from './progress-evidence';
import { sanitizeEvidenceText } from './evidence-content';

/** Read the certified immutable tree, never the current index or dirty checkout. */
export async function readReviewedDeliveryDiff(
  id: string,
  paths: RuntimePaths,
) {
  const pipeline = requireDelivery(id, paths);
  let diff: string | null = null;
  let unavailableReason: string | null = null;
  let failure =
    'Independent review has not settled for this revision. Wait for its bound review result, then refresh the reviewed changes.';
  try {
    const review = pipeline.evidence.findLast(
      (e) =>
        e.kind === 'review' &&
        sameDeliveryRevision(e.revision, pipeline.revision),
    );
    const verification = pipeline.evidence.find(
      (e) => e.id === review?.verificationEvidenceId,
    );
    if (
      !review ||
      !verification ||
      review.producerId === verification.producerId ||
      !settledEvidence(pipeline, review) ||
      !settledEvidence(pipeline, verification) ||
      review.verificationBundleDigest !== verification.bundleDigest
    )
      throw new Error('Bound independent review unavailable');
    failure =
      'The retained reviewed tree could not be read. Reconcile the retained workspace; if its objects are missing, release the plan again to produce reviewable evidence.';
    const { manifest } = await loadLocalManifest(
      codingHandle(requireCodingRun(pipeline.revision.runId, paths), paths),
    );
    const root = manifest.ownedWorktree.root;
    const names = (
      await hostGit(root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        pipeline.revision.baseSha,
        pipeline.revision.treeSha,
        '--',
      ])
    )
      .split('\0')
      .filter(Boolean);
    if (names.some(isSensitiveProgressDiffPath)) {
      failure =
        'The reviewed diff includes sensitive paths and cannot be displayed for approval. Remove private content through a revised plan and validate a fresh candidate.';
      throw new Error('Sensitive paths');
    }
    const content = await hostGit(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      pipeline.revision.baseSha,
      pipeline.revision.treeSha,
      '--',
    ]);
    const safe = sanitizeEvidenceText(
      content,
      paths,
      deliveryEvidenceDisplayMaxBytes,
    );
    if (
      safe.truncated ||
      Buffer.byteLength(content) > deliveryEvidenceDisplayMaxBytes
    ) {
      failure =
        'The reviewed diff exceeds the existing 1 MiB evidence display limit. The full immutable tree remains retained for local inspection. This approval surface requires a complete preview; split the change into smaller reviewed candidates if it cannot be displayed.';
      throw new Error('Diff exceeds display bounds');
    }
    if (safe.text !== content) {
      failure =
        'Private content requires redaction in the reviewed diff. Remove it through a revised plan and validate a fresh candidate before approval.';
      throw new Error('Private content');
    }
    if (requireDelivery(id, paths).version !== pipeline.version) {
      failure =
        'The candidate changed while its reviewed diff was loading. Refresh the current reviewed revision before approval.';
      throw new Error('Delivery changed');
    }
    diff = content;
  } catch {
    unavailableReason = failure;
  }
  return v.parse(reviewedDiffSchema, {
    pipelineId: id,
    revision: pipeline.revision,
    evidenceFingerprint: publicationEvidenceFingerprint(pipeline),
    diff,
    unavailableReason,
  });
}
