import * as v from 'valibot';
import { progressFailureFingerprint } from './progress-evidence-fingerprint';
import {
  deliveryPipelineSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import { renderFactorySpec } from '../../../shared/factory';
import type { RuntimePaths } from '../../runtime-home';
import { hostGit, loadLocalManifest } from '../coding-runs';
import { codingHandle } from '../factory';
import { pipelineValidationContext } from './authority';
import { deliveryBudget, sameDeliveryRevision } from './delivery-aggregate';
import { readDeliveryEvidence } from './evidence-read';
import {
  sanitizeEvidenceText,
  readRetainedEvidenceReceipt,
} from './evidence-content';
import {
  snapshotProgressEvidence,
  type ProgressEvidencePacket,
} from './progress-evidence-contract';
export * from './progress-evidence-contract';

export function isSensitiveProgressDiffPath(name: string) {
  return /(?:^|\/)(?:\.env(?:\.|$)|credentials|secrets|\.git(?:\/|$))|\.(pem|key|p12)$/i.test(
    name,
  );
}

/** Collect only retained revision objects and authenticated report projections.
 * No checkout, writer, or mutable working-tree text enters the snapshot. */
export async function buildProgressEvidencePacket(
  raw: DeliveryPipeline,
  instructions: string,
  requestId: string,
  paths: RuntimePaths,
): Promise<ProgressEvidencePacket> {
  const p = v.parse(deliveryPipelineSchema, raw);
  const context = pipelineValidationContext(p, paths);
  const { manifest } = await loadLocalManifest(
    codingHandle(context.run, paths),
  );
  const root = manifest.ownedWorktree.root;
  const missingEvidence: string[] = [];
  const omittedEvidence: string[] = [];
  const revisions = [
    p.initialRevision,
    ...p.repairs.flatMap((r) => (r.revision ? [r.revision] : [])),
  ];
  if (!revisions.some((r) => sameDeliveryRevision(r, p.revision)))
    throw new Error('Unlinked progress history');
  const candidates: ProgressEvidencePacket['candidates'] = [];
  for (const revision of revisions) {
    let diff: string | null = null;
    try {
      const names = (
        await hostGit(root, [
          'diff',
          '--name-only',
          '-z',
          revision.baseSha,
          revision.treeSha,
          '--',
        ])
      )
        .split('\0')
        .filter(Boolean);
      if (names.some(isSensitiveProgressDiffPath))
        throw new Error('Sensitive diff paths');
      const content = await hostGit(root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        revision.baseSha,
        revision.treeSha,
        '--',
      ]);
      const safe = sanitizeEvidenceText(content, paths, 128000);
      if (
        safe.truncated ||
        Buffer.byteLength(content) > 128000 ||
        safe.text !== content
      ) {
        omittedEvidence.push(
          `Candidate ${revision.candidateDigest} diff exceeds bounds or needs privacy redaction`,
        );
      } else diff = content;
    } catch {
      missingEvidence.push(
        `Candidate ${revision.candidateDigest} immutable diff unavailable`,
      );
    }
    const observations: ProgressEvidencePacket['candidates'][number]['observations'] =
      [];
    const refs = [
      ...p.evidence.filter((e) => sameDeliveryRevision(e.revision, revision)),
      ...p.feedback.filter((e) => sameDeliveryRevision(e.revision, revision)),
    ];
    if (refs.length > 30)
      omittedEvidence.push(
        `Candidate ${revision.candidateDigest} older reports omitted`,
      );
    for (const ref of refs.slice(-30)) {
      try {
        const report = await readDeliveryEvidence(
          { deliveryId: p.pipelineId, evidenceId: ref.id },
          paths,
        );
        if (
          !['verification', 'review', 'feedback'].includes(report.kind) ||
          (report.kind !== 'feedback' &&
            (!report.effect.settled || !report.effect.accounted)) ||
          !sameDeliveryRevision(report.revision, revision)
        )
          throw new Error('Report revision mismatch');
        let feedbackChecks: unknown = null;
        if (report.kind === 'feedback') {
          const observation = v.parse(
            v.object({
              checks: v.array(
                v.object({
                  name: v.string(),
                  status: v.string(),
                  conclusion: v.nullable(v.string()),
                }),
              ),
              statuses: v.array(
                v.object({ context: v.string(), state: v.string() }),
              ),
            }),
            await readRetainedEvidenceReceipt(p, ref.evidenceRef, paths),
          );
          feedbackChecks = observation;
        }
        const body = JSON.stringify({
          feedbackChecks,
          kind: report.kind,
          result: report.result,
          summary: report.summary,
          checks: report.checks,
          findings: report.findings,
          feedback: 'feedback' in report ? report.feedback : null,
        });
        if (report.truncated || body.length > 128000) {
          omittedEvidence.push(`Report ${ref.id} content omitted or truncated`);
          continue;
        }
        // Fingerprint substantive failures without elapsed times or revision ids.
        const failures = {
          checks: report.checks
            .filter((c) => !c.passed)
            .map((c) => ({
              command: c.command,
              exitCode: c.exitCode,
              output: c.output,
            })),
          findings: report.findings,
          feedback:
            report.kind === 'feedback'
              ? { checks: feedbackChecks, body: report.feedback.packet }
              : null,
        };
        observations.push({
          ref: ref.id,
          kind: report.kind,
          body,
          fingerprint: progressFailureFingerprint(failures),
        });
      } catch {
        missingEvidence.push(
          `Report ${ref.id} failed retained evidence validation`,
        );
      }
    }
    if (!observations.length)
      missingEvidence.push(
        `Candidate ${revision.candidateDigest} has no retained check, review, or feedback report`,
      );
    candidates.push({ revision, diff, observations });
  }
  const budget = deliveryBudget(p);
  return snapshotProgressEvidence({
    version: 1,
    grantId: p.authorization.id,
    requestId,
    revision: p.revision,
    repairOrdinal: p.repairs.length + 1,
    releasedBrief: renderFactorySpec(context.authority.revision.spec),
    proposedInstructions: instructions,
    candidates,
    priorRepairs: p.repairs.map((r, i) => ({
      ordinal: i + 1,
      revision: r.fromRevision,
      instructions: r.reason,
    })),
    remainingBudget: {
      durationMs: budget.remainingExecutionMs,
      repairs: budget.repairsRemaining,
    },
    missingEvidence,
    omittedEvidence,
  });
}
export const gatherDeliveryProgressPacket = buildProgressEvidencePacket;
