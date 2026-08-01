import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { currentFlueExecutionContext } from '../flue';
import { createReviewSurfaceContextPage } from './context';
import {
  flueFindingProvenance,
  stampReviewFindingSubmissions,
} from './provenance';
import { reviewSurfaceRegistry } from './registry';
import {
  reviewSurfaceActionOutputSchema,
  reviewSurfaceContextInputSchema,
  reviewSurfaceFindingsApplyActionSchema,
  reviewSurfaceFindingsClearActionSchema,
  reviewSurfaceFindingsDismissActionSchema,
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
      output: {
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
      },
    };
  },
});

export const reviewSurfaceContextLookupTool = defineTool({
  name: 'neondeck_review_surface_context_lookup',
  description:
    'Read a paged summary of one active review surface and its process-ephemeral Neon findings. Files, review order, and findings share an offset and bounded page limit; patch bodies are never loaded.',
  input: reviewSurfaceContextInputSchema,
  output: lookupOutputSchema,
  async run({ data: input }) {
    const surface = reviewSurfaceRegistry.read(input.surfaceId);
    if (!surface) {
      return {
        output: {
          ok: false,
          message: 'Review surface is not active.',
          surfaceId: input.surfaceId,
        },
      };
    }
    const findingResult = reviewSurfaceRegistry.readFindings(input.surfaceId);
    return {
      output: await createReviewSurfaceContextPage(
        surface,
        findingResult.findings ?? [],
        input,
      ),
    };
  },
});

export const reviewSurfaceNavigateAction = defineTool({
  name: 'neondeck_review_surface_navigate',
  description:
    'Publish a revision-aware file navigation command to exactly one active review surface. Set focus only when the user explicitly asked to be shown the target.',
  input: reviewSurfaceNavigateInputSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ data: input }) {
    const navigation = reviewSurfaceRegistry.navigate(input.surfaceId, {
      revisionKey: input.revisionKey,
      target: input.target,
    });
    if (!navigation) {
      return {
        output: {
          ok: false,
          action: 'navigate',
          changed: false,
          message: 'Review surface is not active.',
          surfaceId: input.surfaceId,
        },
      };
    }
    return {
      output: {
        ok: true,
        action: 'navigate',
        changed: true,
        message: 'Published a targeted review surface navigation command.',
        surfaceId: input.surfaceId,
        revisionKey: navigation.revisionKey,
        navigation,
      },
    };
  },
});

export const reviewSurfaceFindingsApplyAction = defineTool({
  name: 'neondeck_review_surface_findings_apply',
  description:
    'Atomically apply a bounded batch of revision-bound, process-ephemeral Neon findings to one active review surface. This never creates GitHub comments or mutates prepared diffs.',
  input: reviewSurfaceFindingsApplyActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ data: input }) {
    const context = currentFlueExecutionContext();
    return {
      output: await reviewSurfaceRegistry.applyFindings(input.surfaceId, {
        revisionKey: input.revisionKey,
        findings: stampReviewFindingSubmissions(
          input.findings,
          flueFindingProvenance(context),
        ),
      }),
    };
  },
});

export const reviewSurfaceFindingsDismissAction = defineTool({
  name: 'neondeck_review_surface_findings_dismiss',
  description:
    'Explicitly dismiss selected process-ephemeral Neon findings on one active review surface when the expected source and revision are still mounted.',
  input: reviewSurfaceFindingsDismissActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await reviewSurfaceRegistry.dismissFindings(input.surfaceId, {
        sourceId: input.sourceId,
        revisionKey: input.revisionKey,
        findingIds: input.findingIds,
        reason: input.reason,
      }),
    };
  },
});

export const reviewSurfaceFindingsClearAction = defineTool({
  name: 'neondeck_review_surface_findings_clear',
  description:
    'Explicitly remove selected or all process-ephemeral Neon findings from one active review surface when the expected source and revision are still mounted.',
  input: reviewSurfaceFindingsClearActionSchema,
  output: reviewSurfaceActionOutputSchema,
  async run({ data: input }) {
    return {
      output: await reviewSurfaceRegistry.clearFindings(input.surfaceId, {
        sourceId: input.sourceId,
        revisionKey: input.revisionKey,
        findingIds: input.findingIds,
      }),
    };
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
