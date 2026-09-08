import { useWorkflowTrial } from './useWorkflowTrial';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import {
  repoFactoryWorkflowsSchema,
  type RepoFactoryWorkflows,
  type RepoWorkflowsSnapshot,
  type RepoWorkflowProposal,
} from '../../../../shared/repo-workflows';
import {
  getRepoWorkflows,
  saveRepoWorkflows,
  proposeRepoWorkflows,
} from './workflow-api';
import { WorkflowProfileEditor } from './WorkflowProfileEditor';
import { WorkflowRunProgress } from './WorkflowRunProgress';
import './workflows.css';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed. Please retry.';
export function FactoryRepoWorkflows({
  repos,
  initialRepoId,
}: {
  repos: { id: string; name: string }[];
  initialRepoId?: string;
}) {
  const [selected, setSelected] = useState(
    repos.some((repo) => repo.id === initialRepoId)
      ? initialRepoId!
      : (repos[0]?.id ?? ''),
  );
  const [visited, setVisited] = useState<string[]>(selected ? [selected] : []);
  return (
    <section
      id="factory-repo-workflows"
      className="factory-workflows"
      aria-label="Repository workflows"
    >
      <h2>Repository workflows</h2>
      <p>Prepare dependencies and verify each repository before delivery.</p>
      {!repos.length ? (
        <p>
          Register a repository in dashboard repository setup or with{' '}
          <code>neondeck repo add</code>, then return here to configure its
          workflow.
        </p>
      ) : (
        <>
          <label>
            Workflow repository
            <select
              value={selected}
              onChange={(event) => {
                const id = event.target.value;
                setSelected(id);
                setVisited((previous) =>
                  previous.includes(id) ? previous : [...previous, id],
                );
              }}
            >
              <option value="" disabled>
                Choose a repository
              </option>
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          {visited
            .filter((id) => repos.some((repo) => repo.id === id))
            .map((id) => (
              <div key={id} hidden={id !== selected}>
                <RepoWorkflowSetup repoId={id} active={id === selected} />
              </div>
            ))}
        </>
      )}
    </section>
  );
}
function RepoWorkflowSetup({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const query = useQuery({
    queryKey: ['repo-workflows', repoId],
    queryFn: ({ signal }) => getRepoWorkflows(repoId, { signal }),
    refetchInterval: 15000,
  });
  return (
    <>
      {query.isPending && <output>Loading repository workflows…</output>}
      {query.error && (
        <p role="alert">
          Could not refresh workflows. Existing edits are retained.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Retry workflow refresh
          </button>
        </p>
      )}
      {query.data && (
        <RepoWorkflowEditor
          key={repoId}
          snapshot={query.data}
          active={active}
        />
      )}
    </>
  );
}
export function RepoWorkflowEditor({
  snapshot,
  active = true,
}: {
  snapshot: RepoWorkflowsSnapshot;
  active?: boolean;
}) {
  const client = useQueryClient();
  const [base, setBase] = useState(snapshot);
  const [draft, setDraft] = useState<RepoFactoryWorkflows | null>(() =>
    structuredClone(snapshot.workflows),
  );
  const [profileIndex, setProfileIndex] = useState(0);
  const [proposal, setProposal] = useState<RepoWorkflowProposal | null>(null);
  const [busy, setBusy] = useState('');
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const trial = useWorkflowTrial(snapshot.repoId, active);
  const run = trial.run;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base.workflows);
  const stale = snapshot.fingerprint !== base.fingerprint;
  const profile = draft?.profiles[profileIndex];
  async function action(label: string, work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy('');
    }
  }
  return (
    <div className="workflow-editor">
      <div className="factory-toolbar">
        <h3>Workflow configuration</h3>
        <output>
          {dirty
            ? 'Unsaved changes'
            : base.workflows
              ? 'Saved'
              : 'Not configured'}
        </output>
      </div>
      {stale && (
        <p role="alert">
          Saved settings changed elsewhere. Your draft is retained. Copy any
          edits you need, then load the latest settings before saving.
        </p>
      )}
      <button
        type="button"
        disabled={!!busy}
        onClick={() => {
          setBase(snapshot);
          setDraft(structuredClone(snapshot.workflows));
          setProfileIndex(0);
          setProposal(null);
          setError('');
          setNotice('Loaded current saved settings.');
        }}
      >
        Load saved settings{dirty ? ' and discard draft' : ''}
      </button>
      <form
        className="factory-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action('save', async () => {
            const workflows = draft
              ? v.parse(repoFactoryWorkflowsSchema, {
                  ...draft,
                  profiles: draft.profiles.map((item) => ({
                    ...item,
                    environmentRefs: item.environmentRefs
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })),
                })
              : null;
            const saved = await saveRepoWorkflows(base.repoId, {
              expectedFingerprint: base.fingerprint,
              workflows,
            });
            setBase(saved);
            setDraft(structuredClone(saved.workflows));
            setProposal(null);
            client.setQueryData(['repo-workflows', base.repoId], saved);
            setNotice(
              'Workflow saved. Choose Test setup and validation to run it.',
            );
          });
        }}
      >
        <fieldset disabled={!!busy}>
          {!draft && (
            <p>
              No workflow configured. Add a profile or ask Neon to suggest
              commands from this repository.
            </p>
          )}
          {draft && (
            <>
              <div className="workflow-fields">
                <label>
                  Editing profile
                  <select
                    value={profileIndex}
                    onChange={(e) => setProfileIndex(Number(e.target.value))}
                  >
                    {draft.profiles.map((item, index) => (
                      <option key={index} value={index}>
                        {item.name || 'Unnamed profile'}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Default profile
                  <select
                    value={draft.defaultProfileId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultProfileId: e.target.value || null,
                      })
                    }
                  >
                    <option value="">Choose per task</option>
                    {draft.profiles.map((item, index) => (
                      <option key={index} value={item.id}>
                        {item.name || 'Unnamed profile'}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {profile && (
                <WorkflowProfileEditor
                  profile={profile}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      defaultProfileId:
                        draft.defaultProfileId === profile.id
                          ? next.id
                          : draft.defaultProfileId,
                      profiles: draft.profiles.map((item, index) =>
                        index === profileIndex ? next : item,
                      ),
                    })
                  }
                />
              )}
              <button
                type="button"
                onClick={() => {
                  const remaining = draft.profiles.filter(
                    (_, index) => index !== profileIndex,
                  );
                  setDraft(
                    remaining.length
                      ? {
                          ...draft,
                          profiles: remaining,
                          defaultProfileId:
                            draft.defaultProfileId === profile?.id
                              ? null
                              : draft.defaultProfileId,
                        }
                      : null,
                  );
                  setProfileIndex(0);
                }}
              >
                Remove selected profile
              </button>
            </>
          )}
          <div className="factory-toolbar">
            <button
              type="button"
              disabled={(draft?.profiles.length ?? 0) >= 8}
              onClick={() => {
                const profiles = draft?.profiles ?? [];
                let suffix = profiles.length + 1;
                while (profiles.some((item) => item.id === `profile-${suffix}`))
                  suffix++;
                const id = `profile-${suffix}`;
                setDraft({
                  defaultProfileId: draft ? draft.defaultProfileId : id,
                  profiles: [
                    ...profiles,
                    {
                      id,
                      name: `Profile ${suffix}`,
                      setupCommands: [],
                      validationCommands: [],
                      setupTimeoutMs: 300000,
                      validationTimeoutMs: 300000,
                      runtime: {},
                      environmentRefs: [],
                    },
                  ],
                });
                setProfileIndex(profiles.length);
              }}
            >
              Add profile
            </button>
            <button
              type="button"
              disabled={stale}
              onClick={() =>
                void action('suggest', async () => {
                  const result = await proposeRepoWorkflows(
                    base.repoId,
                    base.fingerprint,
                  );
                  if (result.fingerprint !== base.fingerprint)
                    throw new Error(
                      'Settings changed while Neon prepared this suggestion. Load saved settings and try again.',
                    );
                  setProposal(result.proposal);
                })
              }
            >
              {busy === 'suggest'
                ? 'Neon is reading repository evidence…'
                : 'Ask Neon to suggest workflows'}
            </button>
            <button type="submit" disabled={!dirty || stale}>
              {busy === 'save' ? 'Saving workflow…' : 'Save workflow'}
            </button>
          </div>
        </fieldset>
      </form>
      {proposal && (
        <section aria-label="Suggested workflows">
          <h3>Neon’s suggestion</h3>
          <p>{proposal.rationale}</p>
          <p>Repository evidence: {proposal.evidencePaths.join(', ')}</p>
          <p>
            Evidence revision: <code>{proposal.evidenceRevision}</code>
          </p>
          <p>
            {proposal.workflows.profiles.map((item) => item.name).join(', ')}
          </p>
          <button
            type="button"
            disabled={!!busy || stale}
            onClick={() => {
              setDraft(structuredClone(proposal.workflows));
              setProfileIndex(0);
              setProposal(null);
              setNotice(
                'Suggestion added to your draft. Review every command before saving.',
              );
            }}
          >
            Use suggestion{dirty ? ' and replace draft' : ''}
          </button>
          <button type="button" onClick={() => setProposal(null)}>
            Dismiss suggestion
          </button>
        </section>
      )}
      {error && (
        <p className="factory-error" role="alert">
          {error} Your draft is retained.
        </p>
      )}
      {notice && <output>{notice}</output>}
      <section className="workflow-test">
        <h3>Test the saved profile</h3>
        <p>
          Runs setup, then checks in a disposable checkout of the current remote
          default branch. Output appears below.
        </p>
        {(dirty || stale) && (
          <p>Save your changes or load saved settings before testing.</p>
        )}
        {trial.discovery.isFetching && (
          <output>Checking for an existing workflow test…</output>
        )}
        {trial.discovery.isError && (
          <p role="alert">
            Could not check for an existing test. Starting another test is
            blocked.{' '}
            <button
              type="button"
              onClick={() => void trial.discovery.refetch()}
            >
              Retry test discovery
            </button>
          </p>
        )}
        {run?.cleanup === 'retained' && (
          <p role="alert">
            This test has a retained checkout. Review its guidance before
            starting another test.{' '}
            <button
              type="button"
              onClick={() => void trial.discovery.refetch()}
            >
              Refresh test ownership
            </button>
          </p>
        )}
        <button
          type="button"
          disabled={
            !!busy ||
            dirty ||
            stale ||
            !profile ||
            !base.workflows ||
            trial.blocked
          }
          onClick={() =>
            void action('test', async () => {
              if (!profile) return;
              await trial.start(profile.id, base.fingerprint);
            })
          }
        >
          {busy === 'test' ? 'Starting test…' : 'Test setup and validation'}
        </button>
        {run && (
          <WorkflowRunProgress
            key={run.runId}
            initial={run}
            onObserved={trial.observed}
          />
        )}
      </section>
    </div>
  );
}
