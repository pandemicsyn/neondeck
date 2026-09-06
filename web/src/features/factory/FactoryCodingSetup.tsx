import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import {
  factoryCodingConfigSchema,
  type FactoryCodingState,
} from '../../../../shared/factory-coding';
import {
  getFactoryCodingState,
  saveFactoryCodingConfig,
} from '../../api/factory-coding';

export const factoryCodingStateKey = ['factory-coding-state'];
export function FactoryCodingSetup() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: factoryCodingStateKey,
    queryFn: ({ signal }) => getFactoryCodingState({ signal }),
    refetchInterval: 15000,
  });
  const [editing, setEditing] = useState(false);
  return (
    <section className="factory-coding-setup" aria-label="Local coding setup">
      <div className="factory-toolbar">
        <h2>Local coding</h2>
        {state.data && (
          <span className="factory-coding-badge">
            {!state.data.config.enabled
              ? 'Disabled'
              : state.data.readiness.ready
                ? 'Ready'
                : 'Needs setup'}
          </span>
        )}
        <button onClick={() => setEditing(!editing)} disabled={!state.data}>
          {editing ? 'Close setup' : 'Configure coding'}
        </button>
      </div>
      {state.isPending && <output>Loading coding readiness…</output>}
      {state.error && (
        <p role="alert" className="factory-error">
          Coding readiness unavailable.{' '}
          <button onClick={() => void state.refetch()}>
            Refresh readiness
          </button>
        </p>
      )}
      {state.data && (
        <>
          <p>
            {state.data.config.enabled
              ? 'Eligible human-released briefs dispatch automatically, one writer at a time.'
              : 'Enable local coding to turn human-released briefs into retained candidates.'}{' '}
            Candidates await your review.
          </p>
          {state.data.readiness.blockers.length > 0 && (
            <ul className="factory-coding-blockers">
              {state.data.readiness.blockers.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="factory-note">
            CLI {state.data.readiness.installedVersion ?? 'not detected'} ·
            Supported {state.data.readiness.supportedVersion}
          </p>
          {editing && (
            <FactoryCodingConfigForm
              state={state.data}
              onSaved={async () => {
                setEditing(false);
                await client.invalidateQueries({
                  queryKey: factoryCodingStateKey,
                });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function FactoryCodingConfigForm({
  state,
  onSaved,
}: {
  state: FactoryCodingState;
  onSaved: () => Promise<void>;
}) {
  const [base, setBase] = useState(state);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const value = (name: string) => {
      const entry = values.get(name);
      return typeof entry === 'string' ? entry : '';
    };
    setError('');
    const parsed = v.safeParse(factoryCodingConfigSchema, {
      ...base.config,
      enabled: values.has('enabled'),
      executable: value('executable') || null,
      model: value('model') || null,
      path: value('path'),
      auth: value('authEnv')
        ? { kind: value('authKind'), env: value('authEnv') }
        : null,
      wallTimeMs: Number(value('minutes')) * 60000,
      maxOutputBytes: Number(value('outputMiB')) * 1024 * 1024,
    });
    if (!parsed.success) {
      setError(
        'Check the executable, model, credential reference, PATH and finite limits.',
      );
      return;
    }
    setBusy(true);
    try {
      await saveFactoryCodingConfig(parsed.output, base.configFingerprint);
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Coding settings could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }
  const stale = base.configFingerprint !== state.configFingerprint;
  return (
    <div>
      {stale && (
        <output className="factory-coding-status">
          Coding settings changed elsewhere. Your edits are retained.{' '}
          <button
            disabled={busy}
            onClick={() => {
              setBase(state);
              setGeneration((g) => g + 1);
              setError('');
            }}
          >
            Reload current coding settings
          </button>
        </output>
      )}
      {error && (
        <p role="alert" className="factory-error">
          {error} Your settings are retained; refresh readiness and review
          before saving again.
        </p>
      )}
      <form
        key={generation}
        className="factory-form factory-coding-form"
        onSubmit={save}
      >
        <fieldset disabled={busy}>
          <label className="factory-coding-opt-in">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={base.config.enabled}
            />{' '}
            Enable automatic coding of eligible released briefs
          </label>
          <p className="factory-note">
            Uses a managed worktree and a private harness home for trusted local
            repositories. This is not an OS sandbox. Publishing, merging and
            deployment remain outside this permission.
          </p>
          <div className="factory-coding-fields">
            <label>
              Codex executable
              <input
                name="executable"
                placeholder="/usr/local/bin/codex"
                defaultValue={base.config.executable ?? ''}
              />
            </label>
            <label>
              Model
              <input
                name="model"
                placeholder="Configured Codex model"
                defaultValue={base.config.model ?? ''}
              />
            </label>
            <label>
              Credential source
              <select
                name="authKind"
                defaultValue={base.config.auth?.kind ?? 'api-key'}
              >
                <option value="api-key">API key environment reference</option>
                <option value="auth-json">
                  Auth file environment reference
                </option>
              </select>
            </label>
            <label>
              Environment variable name
              <input
                name="authEnv"
                placeholder="CODEX_API_KEY"
                defaultValue={base.config.auth?.env ?? ''}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Time limit (minutes)
              <input
                name="minutes"
                type="number"
                min={1 / 60}
                max={45}
                step="any"
                defaultValue={base.config.wallTimeMs / 60000}
                required
              />
            </label>
            <label>
              Output limit (MiB)
              <input
                name="outputMiB"
                type="number"
                min={1 / 1024}
                max={64}
                step="any"
                defaultValue={base.config.maxOutputBytes / 1024 / 1024}
                required
              />
            </label>
          </div>
          <label>
            Executable search path
            <input
              name="path"
              defaultValue={base.config.path}
              required
              spellCheck={false}
            />
          </label>
          <p className="factory-note">
            Enter only the name of a configured environment variable, never a
            credential value. One active writer; each attempt starts a fresh
            session.
          </p>
          <button disabled={stale}>
            {busy ? 'Saving coding settings…' : 'Save coding settings'}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
