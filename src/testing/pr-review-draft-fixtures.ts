import {
  addPrReviewDraftComment as addDraftComment,
  deletePrReviewDraftComment as deleteDraftComment,
  readLivePrReviewDraft,
  readPrReviewDraft,
  readPrReviewDraftForComment,
  reanchorPrReviewDraft as reanchorDraft,
  updatePrReviewDraftComment as updateDraftComment,
  upsertPrReviewDraft as upsertDraft,
  type GitHubPrReviewVerdict,
} from '../modules/github';

type UpsertOptions = {
  databasePath: string;
  draftId?: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict?: GitHubPrReviewVerdict | null;
  body?: string | null;
  reanchorHeadSha?: boolean;
  expectedRevision?: number;
  expectedAbsent?: boolean;
};

type AddOptions = Omit<
  Parameters<typeof addDraftComment>[0],
  'expectedDraftRevision'
> & { expectedDraftRevision?: number };
type UpdateOptions = Omit<
  Parameters<typeof updateDraftComment>[0],
  'expectedDraftId' | 'expectedDraftRevision'
> & { expectedDraftId?: string; expectedDraftRevision?: number };
type DeleteOptions = Omit<
  Parameters<typeof deleteDraftComment>[0],
  'expectedDraftId' | 'expectedDraftRevision'
> & { expectedDraftId?: string; expectedDraftRevision?: number };
type ReanchorOptions = Omit<
  Parameters<typeof reanchorDraft>[0],
  'expectedRevision'
> & { expectedRevision?: number };

/** Test setup helper. Production callers must provide explicit CAS identity. */
export function upsertPrReviewDraft(options: UpsertOptions) {
  const { draftId, expectedRevision, expectedAbsent, ...values } = options;
  if (draftId) {
    if (expectedRevision !== undefined) {
      return upsertDraft({ ...values, draftId, expectedRevision });
    }
    const draft = readPrReviewDraft({
      databasePath: options.databasePath,
      draftId,
    });
    if (!draft) throw new Error('Review draft not found.');
    return upsertDraft({
      ...values,
      draftId,
      expectedRevision: draft.revision,
    });
  }
  if (expectedAbsent) {
    return upsertDraft({ ...values, expectedAbsent: true });
  }
  const live = readLivePrReviewDraft({
    databasePath: options.databasePath,
    repo: options.repo,
    prNumber: options.prNumber,
  });
  return live
    ? upsertDraft({
        ...values,
        draftId: live.id,
        expectedRevision: live.revision,
      })
    : upsertDraft({ ...values, expectedAbsent: true });
}

/** Test setup helper. Production callers must provide explicit CAS identity. */
export function addPrReviewDraftComment(options: AddOptions) {
  const draft = readPrReviewDraft({
    databasePath: options.databasePath,
    draftId: options.draftId,
  });
  if (!draft) throw new Error('Review draft not found.');
  return addDraftComment({
    ...options,
    expectedDraftRevision: options.expectedDraftRevision ?? draft.revision,
  });
}

/** Test setup helper. Production callers must provide explicit CAS identity. */
export function updatePrReviewDraftComment(options: UpdateOptions) {
  const draft = readPrReviewDraftForComment({
    databasePath: options.databasePath,
    commentId: options.commentId,
  });
  if (!draft) throw new Error('Review draft comment not found.');
  return updateDraftComment({
    ...options,
    expectedDraftId: options.expectedDraftId ?? draft.id,
    expectedDraftRevision: options.expectedDraftRevision ?? draft.revision,
  });
}

/** Test setup helper. Production callers must provide explicit CAS identity. */
export function deletePrReviewDraftComment(options: DeleteOptions) {
  const draft = readPrReviewDraftForComment({
    databasePath: options.databasePath,
    commentId: options.commentId,
  });
  if (!draft) throw new Error('Review draft comment not found.');
  return deleteDraftComment({
    ...options,
    expectedDraftId: options.expectedDraftId ?? draft.id,
    expectedDraftRevision: options.expectedDraftRevision ?? draft.revision,
  });
}

/** Test setup helper. Production callers must provide explicit CAS identity. */
export function reanchorPrReviewDraft(options: ReanchorOptions) {
  const draft = readPrReviewDraft({
    databasePath: options.databasePath,
    draftId: options.draftId,
  });
  if (!draft) return null;
  return reanchorDraft({
    ...options,
    expectedRevision: options.expectedRevision ?? draft.revision,
  });
}
