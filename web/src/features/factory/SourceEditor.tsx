import { useState } from 'react';
import type { FactoryDetail } from '../../../../shared/factory';

function snapshot(detail: FactoryDetail) {
  return {
    expectedVersion: detail.work.version,
    title: detail.source.title,
    body: detail.source.body,
    repoId: detail.source.repoId,
  };
}
export function SourceEditor({
  detail,
  repos,
  disabled,
  onSave,
  onReload,
}: {
  detail: FactoryDetail;
  repos: { id: string; name: string }[];
  disabled: boolean;
  onSave: (input: ReturnType<typeof snapshot>) => Promise<FactoryDetail | null>;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState(() => snapshot(detail));
  const stale = draft.expectedVersion !== detail.work.version;
  return (
    <form
      className="factory-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const saved = await onSave(draft);
        if (saved) setDraft(snapshot(saved));
      }}
    >
      <fieldset disabled={disabled} className="factory-editor-fields">
        <legend className="sr-only">Source context editor</legend>
        {stale && (
          <div className="factory-error">
            <p>
              The task changed while this source editor was open. Your local
              edits are retained. Compare the saved source below, then reload
              and reapply any edits you want to keep.
            </p>
            <details>
              <summary>
                Current saved source · task version {detail.work.version}
              </summary>
              <p>{detail.source.title}</p>
              <p>{detail.source.body}</p>
              <p>Repository: {detail.source.repoId ?? 'Unresolved'}</p>
            </details>
          </div>
        )}
        <label>
          Source title
          <input
            name="title"
            required
            maxLength={240}
            value={draft.title}
            onChange={(event) =>
              setDraft({ ...draft, title: event.target.value })
            }
          />
        </label>
        <label>
          Source text
          <textarea
            rows={4}
            name="body"
            maxLength={20000}
            value={draft.body}
            onChange={(event) =>
              setDraft({ ...draft, body: event.target.value })
            }
          />
        </label>
        <label>
          Repository
          <select
            name="repoId"
            value={draft.repoId ?? ''}
            onChange={(event) =>
              setDraft({ ...draft, repoId: event.target.value || null })
            }
          >
            <option value="">Unresolved</option>
            {repos.map((repo) => (
              <option value={repo.id} key={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <div className="factory-toolbar">
          <button disabled={disabled}>Save source context</button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDraft(snapshot(detail));
              onReload();
            }}
          >
            Reload current source (discard local edits)
          </button>
        </div>
      </fieldset>
    </form>
  );
}
