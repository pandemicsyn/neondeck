import { useEffect, useState } from 'react';
import type { FactoryDetail } from '../../../../shared/factory';
import type { FactoryDiscussionReference } from '../../../../shared/factory-planning';
import {
  readWorkbenchDraft,
  writeWorkbenchDraft,
  discardWorkbenchDraft,
  type WorkbenchDraft,
} from './workbench-draft';

// The parent keys this workbench by work id. Failed reads never authorize writes.
export function useFactoryWorkbench(detail: FactoryDetail) {
  const [loaded, setLoaded] = useState(() =>
    readWorkbenchDraft(detail.work.id),
  );
  const stored = loaded.status === 'loaded' ? loaded.value : undefined;
  const latest = detail.revisions.at(-1)?.version ?? 1;
  const [editor, setEditor] = useState<WorkbenchDraft['editor']>(
    stored?.editor ?? null,
  );
  const [viewedVersion, setViewedVersion] = useState(
    stored?.viewedVersion ?? latest,
  );
  const [compareVersion, setCompareVersion] = useState(
    stored?.compareVersion ?? detail.revisions.at(-2)?.version ?? latest,
  );
  const [compare, setCompare] = useState(stored?.compare ?? false);
  const [workbenchView, setWorkbenchView] = useState<'chat' | 'brief'>(
    stored?.workbenchView ?? 'brief',
  );
  const [discussion, setDiscussion] = useState<
    FactoryDiscussionReference | undefined
  >(stored?.discussion);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    if (loaded.status === 'failed') return;
    setStorageError(
      !writeWorkbenchDraft(detail.work.id, {
        editor,
        viewedVersion,
        compareVersion,
        compare,
        workbenchView,
        discussion,
      }),
    );
  }, [
    detail.work.id,
    loaded.status,
    editor,
    viewedVersion,
    compareVersion,
    compare,
    workbenchView,
    discussion,
  ]);
  function retryRecovery() {
    const next = readWorkbenchDraft(detail.work.id);
    if (next.status === 'loaded') {
      setEditor(next.value.editor);
      setViewedVersion(next.value.viewedVersion);
      setCompareVersion(next.value.compareVersion);
      setCompare(next.value.compare);
      setWorkbenchView(next.value.workbenchView);
      setDiscussion(next.value.discussion);
    }
    // A transient failed read must not silently discard retained recovery data.
    if (next.status !== 'missing')
      setLoaded(
        next.status === 'failed' &&
          next.raw === null &&
          loaded.status === 'failed'
          ? { ...next, raw: loaded.raw }
          : next,
      );
  }
  function discardRecovery() {
    if (discardWorkbenchDraft(detail.work.id)) {
      setLoaded({ status: 'missing' });
      setStorageError(false);
    } else setStorageError(true);
  }
  return {
    editor,
    setEditor,
    viewedVersion,
    setViewedVersion,
    compareVersion,
    setCompareVersion,
    compare,
    setCompare,
    workbenchView,
    setWorkbenchView,
    discussion,
    setDiscussion,
    storageError,
    recovery: loaded.status === 'failed' ? loaded : null,
    retryRecovery,
    discardRecovery,
  };
}
