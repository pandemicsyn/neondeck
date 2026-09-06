import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runtimePaths, ensureRuntimeHomeSync } from '../runtime-home';
import { dbRun, submitFactoryWork } from '../modules/factory/service';
import { prepareFactoryTriage } from '../modules/factory';
import * as deliveries from '../modules/pr-events';
import * as evidence from './pr-review-submission-followups';
import * as autopilot from '../modules/autopilot/owner/settlement';
import * as reviews from '../modules/pr-review-assist';
import * as learning from '../modules/learning/reviews';
import * as briefings from '../modules/briefings';
import { recoverFlueRuntimeServices } from './create-app';

it.each([true, false])(
  'isolates corrupt factory recovery on every startup attempt (enabled=%s)',
  async (enabled) => {
    const home = mkdtempSync(join(tmpdir(), 'factory-recovery-isolation-'));
    const paths = runtimePaths(home);
    ensureRuntimeHomeSync(paths);
    const config = (enabled: boolean) =>
      writeFileSync(
        paths.config,
        JSON.stringify({
          version: 1,
          factory: { enabled },
          models: { default: 'faux/faux-1' },
        }),
      );
    config(true);
    const work = submitFactoryWork(
      {
        requestKey: 'corrupt',
        title: 'Synthetic task',
        body: 'Recovery fixture',
        repoId: null,
      },
      { kind: 'human', id: 'local-operator' },
      paths,
    );
    const intent = prepareFactoryTriage(work.work.id, paths)!;
    dbRun(paths, (db) =>
      db
        .prepare('UPDATE factory_planning_intents SET record=? WHERE id=?')
        .run('{}', intent.id),
    );
    config(enabled);
    const recoveries = [
      vi.spyOn(deliveries, 'recoverPrReviewDeliveryFollowups'),
      vi.spyOn(evidence, 'recoverPrReviewEvidenceFollowups'),
      vi.spyOn(autopilot, 'recoverInterruptedAutopilotOwners'),
      vi.spyOn(reviews, 'recoverInterruptedPrReviewAssists'),
      vi.spyOn(learning, 'recoverInterruptedLearningReviews'),
      vi.spyOn(briefings, 'recoverInterruptedBriefingAdmissions'),
    ];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const attempt of [1, 2]) {
        await expect(
          recoverFlueRuntimeServices({
            paths,
            scheduler: false,
            readBriefingConversationHistory: async () => null,
          }),
        ).rejects.toThrow();
        for (const recovery of recoveries)
          expect(recovery).toHaveBeenCalledTimes(attempt);
      }
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('Factory planning recovery'),
        expect.anything(),
      );
    } finally {
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
