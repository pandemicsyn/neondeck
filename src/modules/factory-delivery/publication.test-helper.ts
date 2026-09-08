import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { updateDeliveryPipeline } from './store';
import { publicationEvidenceFingerprint } from './delivery-aggregate';
/** Explicit synthetic human decision through the production command boundary. */
export function approveTestPublication(
  r: DeliveryPipeline,
  paths: Pick<RuntimePaths, 'neondeckDatabase'>,
) {
  return updateDeliveryPipeline(
    {
      pipelineId: r.pipelineId,
      expectedVersion: r.version,
      action: {
        type: 'authorize-publication',
        grant: {
          requestId: 'test-publication',
          requestFingerprint: 'a'.repeat(64),
          authorizedBy: 'test-human',
          authorizedAt: '2026-09-07T00:00:00.000Z',
          revision: r.revision,
          evidenceFingerprint: publicationEvidenceFingerprint(r),
          configFingerprint: r.authorization.configFingerprint,
          target: r.authorization.target,
        },
      },
    },
    paths,
  );
}
