import { useEffect, useRef, useState } from 'react';
import type {
  RepoFactoryWorkflows,
  RepoWorkflowProposal,
  RepoWorkflowsSnapshot,
} from '../../../../shared/repo-workflows';
import {
  clearWorkflowDraft,
  readWorkflowDraft,
  writeWorkflowDraft,
} from './workflow-draft';

export function useWorkflowDraft(snapshot: RepoWorkflowsSnapshot) {
  const [restored] = useState(() => readWorkflowDraft(snapshot.repoId));
  const [base, setBase] = useState(
    restored.status === 'loaded' ? restored.value.base : snapshot,
  );
  const [draft, setDraft] = useState<RepoFactoryWorkflows | null>(() =>
    structuredClone(
      restored.status === 'loaded' ? restored.value.draft : snapshot.workflows,
    ),
  );
  const [profileIndex, setProfileIndex] = useState(() =>
    restored.status === 'loaded'
      ? Math.min(
          restored.value.profileIndex,
          Math.max(0, (restored.value.draft?.profiles.length ?? 1) - 1),
        )
      : 0,
  );
  const [proposal, setProposal] = useState<RepoWorkflowProposal | null>(
    restored.status === 'loaded' ? restored.value.proposal : null,
  );
  const [storageNotice, setStorageNotice] = useState(
    restored.status === 'failed'
      ? 'Browser draft could not be restored. Load saved settings to discard the unreadable draft before keeping new edits across reloads.'
      : '',
  );
  const canPersist = useRef(restored.status !== 'failed');
  const persisted = useRef(restored.status === 'loaded');
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.workflows);
  useEffect(() => {
    if (!canPersist.current || (!dirty && !proposal && !persisted.current))
      return;
    const saved = writeWorkflowDraft(snapshot.repoId, {
      version: 1,
      base,
      draft,
      profileIndex,
      proposal,
    });
    if (saved) persisted.current = true;
    setStorageNotice(
      saved
        ? ''
        : 'Browser storage is unavailable or full. Your edits remain here, but may be lost if you reload.',
    );
  }, [snapshot.repoId, base, draft, profileIndex, proposal, dirty]);
  function clearStored() {
    const cleared = clearWorkflowDraft(snapshot.repoId);
    canPersist.current = cleared;
    persisted.current = false;
    setStorageNotice(
      cleared
        ? ''
        : 'The browser draft could not be removed. Old edits may return after reload; browser storage is unavailable.',
    );
  }
  return {
    base,
    setBase,
    draft,
    setDraft,
    profileIndex,
    setProfileIndex,
    proposal,
    setProposal,
    storageNotice,
    clearStored,
  };
}
