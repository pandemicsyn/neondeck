import type { Dispatch, SetStateAction } from 'react';
import {
  renderFactorySpec,
  type FactoryDetail,
  type FactorySpec,
} from '../../../../shared/factory';
import type { WorkbenchDraft } from './workbench-draft';
import { DocumentRevisionDiff } from '../diff-viewer/DocumentRevisionDiff';
import { MarkdownMessage } from '../../components/MarkdownMessage';
type Editor = NonNullable<WorkbenchDraft['editor']>;
type TextField = {
  [K in keyof FactorySpec]: FactorySpec[K] extends string ? K : never;
}[keyof FactorySpec];
export function FactorySpecEditor({
  editor,
  setEditor,
  detail,
  busy,
  onSave,
}: {
  editor: Editor;
  setEditor: Dispatch<SetStateAction<Editor | null>>;
  detail: FactoryDetail;
  busy: boolean;
  onSave: () => Promise<void>;
}) {
  const latest = detail.revisions.at(-1)!;
  const staleEditor =
    editor.version !== detail.work.version ||
    editor.specVersion !== latest.version;
  const document = (r: typeof latest) => ({
    id: `${r.workId}:${r.version}:${r.hash}`,
    label: `v${r.version}`,
    text: renderFactorySpec(r.spec),
  });
  const change = (field: TextField, value: string) =>
    setEditor({ ...editor, spec: { ...editor.spec, [field]: value } });
  return (
    <form
      className="factory-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave();
      }}
    >
      <fieldset disabled={busy} className="factory-editor-fields">
        <legend className="sr-only">Draft editor</legend>
        <h3>Editing v{editor.specVersion}</h3>
        {staleEditor && (
          <section className="factory-error" role="alert">
            <h3>Saved task changed — your text is retained</h3>
            <p>
              Current brief v{latest.version}, source v{detail.source.version}:{' '}
              {detail.source.title}
            </p>
            <details>
              <summary>Review current source</summary>
              <p>{detail.source.body}</p>
            </details>
            <DocumentRevisionDiff
              before={document(latest)}
              after={{
                id: `local:${JSON.stringify(editor.spec)}`,
                label: 'Your unsaved draft',
                text: renderFactorySpec(editor.spec),
              }}
            />
            <p>
              Keeping your text will replace the current brief with your draft
              in a new revision. Review all differences and the current source
              first. Repository context requires its own acknowledgement below.
            </p>
            <button
              type="button"
              onClick={() =>
                setEditor({
                  ...editor,
                  version: detail.work.version,
                  specVersion: latest.version,
                })
              }
            >
              Use current save base and keep my text
            </button>
          </section>
        )}
        <section className="factory-source">
          <h3>Repository context</h3>
          {detail.repoContext ? (
            <>
              <p>
                Path: {detail.repoContext.path}
                <br />
                Branch: {detail.repoContext.defaultBranch}
              </p>
              <p>
                Configured commands:{' '}
                {Object.entries(detail.repoContext.commands)
                  .map(([name, command]) => `${name}: ${command}`)
                  .join('; ') || 'None configured'}
              </p>
            </>
          ) : (
            <p>No registered repository selected.</p>
          )}
          {editor.repoFingerprint !== detail.repoFingerprint && (
            <>
              <p>
                The repository configuration differs from this draft's reviewed
                context. Review the path, branch and commands above before
                accepting it. Your draft text stays intact.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setEditor({
                    ...editor,
                    repoFingerprint: detail.repoFingerprint,
                  })
                }
              >
                Use this reviewed repository context
              </button>
            </>
          )}
        </section>

        {(
          [
            'outcome',
            'scope',
            'nonGoals',
            'approach',
            'constraints',
            'assumptions',
          ] as const
        ).map((field) => (
          <label key={field}>
            {
              {
                outcome: 'Outcome',
                scope: 'Scope',
                nonGoals: 'Non-goals',
                approach: 'Approach (Markdown)',
                constraints: 'Constraints',
                assumptions: 'Assumptions',
              }[field]
            }
            <textarea
              rows={field === 'approach' ? 6 : 3}
              maxLength={20000}
              value={editor.spec[field]}
              onChange={(event) => change(field, event.target.value)}
            />
          </label>
        ))}
        <fieldset>
          <legend>Acceptance criteria</legend>
          {editor.spec.acceptanceCriteria.map((criterion, index) => (
            <label key={criterion.id}>
              {criterion.id}
              <input
                required
                maxLength={240}
                value={criterion.text}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    spec: {
                      ...editor.spec,
                      acceptanceCriteria: editor.spec.acceptanceCriteria.map(
                        (c, i) =>
                          i === index ? { ...c, text: event.target.value } : c,
                      ),
                    },
                  })
                }
              />
              <button
                type="button"
                onClick={() =>
                  setEditor({
                    ...editor,
                    spec: {
                      ...editor.spec,
                      acceptanceCriteria: editor.spec.acceptanceCriteria.filter(
                        (c) => c.id !== criterion.id,
                      ),
                    },
                  })
                }
              >
                Remove {criterion.id}
              </button>
            </label>
          ))}
          <button
            type="button"
            onClick={() =>
              setEditor({
                ...editor,
                spec: {
                  ...editor.spec,
                  acceptanceCriteria: [
                    ...editor.spec.acceptanceCriteria,
                    {
                      id: `ac-${crypto.randomUUID().slice(0, 8)}`,
                      text: '',
                    },
                  ],
                },
              })
            }
          >
            Add criterion
          </button>
        </fieldset>
        <fieldset>
          <legend>Decisions — answers create a human revision</legend>
          {editor.spec.decisions.map((decision, index) => (
            <label key={decision.id}>
              {decision.id} · {decision.question} (
              {decision.blocking ? 'blocking' : 'optional'})
              <textarea
                aria-label={`Answer ${decision.id}`}
                rows={3}
                maxLength={20000}
                value={decision.answer ?? ''}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    spec: {
                      ...editor.spec,
                      decisions: editor.spec.decisions.map((d, i) =>
                        i === index
                          ? {
                              ...d,
                              answer: e.target.value.trim()
                                ? e.target.value
                                : null,
                            }
                          : d,
                      ),
                    },
                  })
                }
              />
            </label>
          ))}
          {!editor.spec.decisions.length && <p>No decisions to resolve.</p>}
        </fieldset>
        <div className="factory-toolbar">
          <button disabled={busy || !!staleEditor} type="submit">
            Save new revision
          </button>
          <button disabled={busy} type="button" onClick={() => setEditor(null)}>
            Cancel edits
          </button>
        </div>
        {editor.specVersion !== latest.version && (
          <details open>
            <summary>Current saved draft v{latest.version}</summary>
            <MarkdownMessage>{renderFactorySpec(latest.spec)}</MarkdownMessage>
          </details>
        )}
      </fieldset>
    </form>
  );
}
