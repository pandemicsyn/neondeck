import { defineAction, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { currentFlueExecutionContext } from '../flue';
import { reviewSurfaceRegistry } from './registry';
import {
  reviewSurfaceActionOutputSchema,
  reviewSurfaceFindingsApplyActionSchema,
  reviewSurfaceFindingsClearActionSchema,
  reviewSurfaceFindingsDismissActionSchema,
  reviewSurfaceIdInputSchema,
  reviewSurfaceNavigateInputSchema,
} from './schemas';

const lookupOutputSchema = v.looseObject({ ok: v.boolean() });

export const reviewSurfacesLookupTool = defineTool({
  name: 'neondeck_review_surfaces_lookup',
  description:
    'List concise metadata for active process-ephemeral review surfaces without patch bodies or finding text.',
  input: v.object({}),
  output: lookupOutputSchema,
  async run() {
    return {
      ok: true,
      surfaces: reviewSurfaceRegistry.list().map((surface) => ({
        surfaceId: surface.surfaceId,
        source: {
          id: surface.source.id,
          kind: surface.source.kind,
          title: surface.source.title,
          revision: surface.source.revision,
        },
        activePath: surface.activePath,
        updatedAt: surface.updatedAt,
        expiresAt: surface.expiresAt,
        findingCount:
          reviewSurfaceRegistry.readFindings(surface.surfaceId).count ?? 0,
      })),
    };
  },
});

export const reviewSurfaceContextLookupTool = defineTool({
  name: 'neondeck_review_surface_context_lookup',
  description:
    'Read one active review surface and its bounded process-ephemeral Neon findings. This does not load patch bodies.',
  input: reviewSurfaceIdInputSchema,
  output: lookupOutputSchema,
  async run({ input }) {
    const surface = reviewSurfaceRegistry.read(input.surfaceId);
    if (!surface) {
      return {
        ok: false,
        message: 'Review surface is not active.',
        surfaceId: input.surfaceId,
      };
    }
    return {
      ...reviewSurfaceRegistry.readFindings(input.surfaceId),
      surface,
    };
  },
});

export const reviewSurfaceNavigateAction = defineAction({
  name: 'neondeck_review_surface_navigate',
  description:
    'Publish a revision-aware file navigation command to exactly one active review surface. Set focus only when the user explicitly asked to be shown the target.',
  input: reviewSurfaceNavigateInputSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ input }) {
    const navigation = reviewSurfaceRegistry.navigate(input.surfaceId, {
      revisionKey: input.revisionKey,
      target: input.target,
    });
    if (!navigation) {
      return {
        ok: false,
        action: 'navigate',
        changed: false,
        message: 'Review surface is not active.',
        surfaceId: input.surfaceId,
      };
    }
    return {
      ok: true,
      action: 'navigate',
      changed: true,
      message: 'Published a targeted review surface navigation command.',
      surfaceId: input.surfaceId,
      revisionKey: navigation.revisionKey,
      navigation,
    };
  },
});

export const reviewSurfaceFindingsApplyAction = defineAction({
  name: 'neondeck_review_surface_findings_apply',
  description:
    'Atomically apply a bounded batch of revision-bound, process-ephemeral Neon findings to one active review surface. This never creates GitHub comments or mutates prepared diffs.',
  input: reviewSurfaceFindingsApplyActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ input }) {
    const workflowRunId = currentFlueExecutionContext()?.runId ?? null;
    return reviewSurfaceRegistry.applyFindings(input.surfaceId, {
      revisionKey: input.revisionKey,
      findings: input.findings.map((finding) => ({
        ...finding,
        provenance: {
          ...finding.provenance,
          workflowRunId: workflowRunId ?? finding.provenance.workflowRunId,
        },
      })),
    });
  },
});

export const reviewSurfaceFindingsDismissAction = defineAction({
  name: 'neondeck_review_surface_findings_dismiss',
  description:
    'Explicitly dismiss selected process-ephemeral Neon findings on one active review surface.',
  input: reviewSurfaceFindingsDismissActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ input }) {
    return reviewSurfaceRegistry.dismissFindings(input.surfaceId, {
      findingIds: input.findingIds,
      reason: input.reason,
    });
  },
});

export const reviewSurfaceFindingsClearAction = defineAction({
  name: 'neondeck_review_surface_findings_clear',
  description:
    'Explicitly remove selected or all process-ephemeral Neon findings from one active review surface.',
  input: reviewSurfaceFindingsClearActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ input }) {
    return reviewSurfaceRegistry.clearFindings(input.surfaceId, {
      findingIds: input.findingIds,
    });
  },
});

export const neondeckReviewSurfaceTools = [
  reviewSurfacesLookupTool,
  reviewSurfaceContextLookupTool,
];

export const neondeckReviewSurfaceActions = [
  reviewSurfaceNavigateAction,
  reviewSurfaceFindingsApplyAction,
  reviewSurfaceFindingsDismissAction,
  reviewSurfaceFindingsClearAction,
];
