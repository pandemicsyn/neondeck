import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  prReviewTourSchemaVersion,
  type PrReviewTour,
  type PrReviewTourDraft,
  type PrReviewTourProvenance,
} from '../../../shared/pr-review-tour';

type TourRow = {
  conversation_id: string;
  id: string;
  generation: number;
  review_id: string;
  repo_full_name: string;
  head_sha: string;
  revision_key: string;
  title: string;
  summary: string;
  source_finding_id: string | null;
  author_role: string;
  model: string | null;
  submission_id: string | null;
  created_at: string;
};

type StepRow = {
  id: string;
  key: string;
  ordinal: number;
  file: string;
  side: 'additions' | 'deletions';
  start_line: number;
  end_line: number;
  symbol: string | null;
  explanation: string;
};

type ReceiptRow = { result_json: string };

export type ReplaceTourStoreResult = {
  changed: boolean;
  tour: PrReviewTour;
};

export function readPrReviewTour(
  conversationId: string,
  paths: RuntimePaths,
): PrReviewTour | null {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return readTour(database, conversationId);
  } finally {
    database.close();
  }
}

export function readPrReviewTourPublication(
  toolCallId: string,
  paths: RuntimePaths,
): PrReviewTour | null {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const receipt = database
      .prepare(
        'SELECT result_json FROM pr_review_tour_publications WHERE tool_call_id = ?;',
      )
      .get(toolCallId) as ReceiptRow | undefined;
    return receipt ? (JSON.parse(receipt.result_json) as PrReviewTour) : null;
  } finally {
    database.close();
  }
}

export function replacePrReviewTourStore(
  input: {
    conversationId: string;
    reviewId: string;
    repoFullName: string;
    headSha: string;
    revisionKey: string;
    draft: PrReviewTourDraft;
    provenance: PrReviewTourProvenance;
    toolCallId: string;
    assertCurrent?: () => void;
  },
  paths: RuntimePaths,
): ReplaceTourStoreResult {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const priorReceipt = database
        .prepare(
          'SELECT result_json FROM pr_review_tour_publications WHERE tool_call_id = ?;',
        )
        .get(input.toolCallId) as ReceiptRow | undefined;
      if (priorReceipt) {
        const tour = JSON.parse(priorReceipt.result_json) as PrReviewTour;
        return { changed: false, tour };
      }

      input.assertCurrent?.();

      const current = readTour(database, input.conversationId);
      const generation = (current?.generation ?? 0) + 1;
      const tourId = randomUUID();
      const steps = input.draft.steps.map((step, index) => ({
        id: randomUUID(),
        key: step.key,
        ordinal: index + 1,
        file: step.file,
        anchor: {
          kind: 'line-range' as const,
          side: step.side,
          startLine: step.startLine,
          endLine: step.endLine,
        },
        symbol: step.symbol,
        explanation: step.explanation,
      }));
      const tour: PrReviewTour = {
        schemaVersion: prReviewTourSchemaVersion,
        id: tourId,
        generation,
        conversationId: input.conversationId,
        reviewId: input.reviewId,
        repoFullName: input.repoFullName,
        headSha: input.headSha,
        revisionKey: input.revisionKey,
        title: input.draft.title,
        summary: input.draft.summary,
        steps,
        sourceFindingId: input.draft.sourceFindingId ?? null,
        provenance: input.provenance,
      };

      database
        .prepare(
          `
            INSERT INTO pr_review_tours (
              conversation_id, id, generation, review_id, repo_full_name,
              head_sha, revision_key, title, summary, source_finding_id,
              author_role, model, submission_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
              id = excluded.id,
              generation = excluded.generation,
              review_id = excluded.review_id,
              repo_full_name = excluded.repo_full_name,
              head_sha = excluded.head_sha,
              revision_key = excluded.revision_key,
              title = excluded.title,
              summary = excluded.summary,
              source_finding_id = excluded.source_finding_id,
              author_role = excluded.author_role,
              model = excluded.model,
              submission_id = excluded.submission_id,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at;
          `,
        )
        .run(
          tour.conversationId,
          tour.id,
          tour.generation,
          tour.reviewId,
          tour.repoFullName,
          tour.headSha,
          tour.revisionKey,
          tour.title,
          tour.summary,
          tour.sourceFindingId,
          tour.provenance.authorRole,
          tour.provenance.model,
          tour.provenance.submissionId,
          tour.provenance.createdAt,
          tour.provenance.createdAt,
        );
      database
        .prepare('DELETE FROM pr_review_tour_steps WHERE conversation_id = ?;')
        .run(tour.conversationId);
      const insertStep = database.prepare(
        `
          INSERT INTO pr_review_tour_steps (
            id, conversation_id, key, ordinal, file, side, start_line,
            end_line, symbol, explanation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `,
      );
      for (const step of tour.steps) {
        insertStep.run(
          step.id,
          tour.conversationId,
          step.key,
          step.ordinal,
          step.file,
          step.anchor.side,
          step.anchor.startLine,
          step.anchor.endLine,
          step.symbol,
          step.explanation,
        );
      }
      database
        .prepare(
          `
            INSERT INTO pr_review_tour_publications (
              tool_call_id, conversation_id, tour_id, generation,
              result_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?);
          `,
        )
        .run(
          input.toolCallId,
          tour.conversationId,
          tour.id,
          tour.generation,
          JSON.stringify(tour),
          tour.provenance.createdAt,
        );
      return { changed: true, tour };
    });
  } finally {
    database.close();
  }
}

function readTour(database: DatabaseSync, conversationId: string) {
  const row = database
    .prepare('SELECT * FROM pr_review_tours WHERE conversation_id = ?;')
    .get(conversationId) as TourRow | undefined;
  if (!row) return null;
  const steps = database
    .prepare(
      `
        SELECT id, key, ordinal, file, side, start_line, end_line, symbol,
               explanation
        FROM pr_review_tour_steps
        WHERE conversation_id = ?
        ORDER BY ordinal ASC;
      `,
    )
    .all(conversationId) as unknown as StepRow[];
  return {
    schemaVersion: prReviewTourSchemaVersion,
    id: row.id,
    generation: row.generation,
    conversationId: row.conversation_id,
    reviewId: row.review_id,
    repoFullName: row.repo_full_name,
    headSha: row.head_sha,
    revisionKey: row.revision_key,
    title: row.title,
    summary: row.summary,
    sourceFindingId: row.source_finding_id,
    provenance: {
      authorRole: row.author_role,
      model: row.model,
      submissionId: row.submission_id,
      createdAt: row.created_at,
    },
    steps: steps.map((step) => ({
      id: step.id,
      key: step.key,
      ordinal: step.ordinal,
      file: step.file,
      anchor: {
        kind: 'line-range' as const,
        side: step.side,
        startLine: step.start_line,
        endLine: step.end_line,
      },
      symbol: step.symbol,
      explanation: step.explanation,
    })),
  } satisfies PrReviewTour;
}
