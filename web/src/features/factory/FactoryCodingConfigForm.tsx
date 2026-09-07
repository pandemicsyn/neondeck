import { useState, type FormEvent } from 'react';
import * as v from 'valibot';
import {
  factoryCodingConfigSchema,
  type FactoryCodingState,
} from '../../../../shared/factory-coding';
import { saveFactoryCodingConfig } from '../../api/factory-coding';

export function FactoryCodingConfigForm({
  state,
  onSaved,
  unavailable = false,
}: {
  state: FactoryCodingState;
  unavailable?: boolean;
  onSaved: () => Promise<void>;
}) {
  const [base, setBase] = useState(state);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [adapterId, setAdapterId] = useState(
    base.config.adapter?.id ?? 'codex',
  );
  const adapter = state.adapters.find((item) => item.id === adapterId);
  const savedAdapterId = base.config.adapter?.id ?? 'codex';
  const changedAdapter = adapterId !== savedAdapterId;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy ||
      unavailable ||
      base.configFingerprint !== state.configFingerprint ||
      !adapter
    )
      return;
    const values = new FormData(event.currentTarget);
    const value = (name: string) => {
      const entry = values.get(name);
      return typeof entry === 'string' ? entry : '';
    };
    setError('');
    const minutes = Number(value('minutes'));
    const outputMiB = Number(value('outputMiB'));
    const parsed = v.safeParse(factoryCodingConfigSchema, {
      ...base.config,
      enabled: values.has('enabled'),
      adapter:
        adapterId === savedAdapterId &&
        !base.config.adapter &&
        value('cliVersion') === adapter.supportedVersion
          ? null
          : adapter
            ? {
                id: adapter.id,
                contractVersion: adapter.contractVersion,
                cliVersion: value('cliVersion'),
              }
            : null,
      executable: value('executable') || null,
      model: value('model') || null,
      path: value('path'),
      auth: value('authEnv')
        ? { kind: value('authKind'), env: value('authEnv') }
        : null,
      // Reject out-of-range inputs before rounding to the API's integer units.
      wallTimeMs:
        minutes >= 1 / 60 && minutes <= 45 ? Math.round(minutes * 60000) : NaN,
      maxOutputBytes:
        outputMiB >= 1 / 1024 && outputMiB <= 64
          ? Math.round(outputMiB * 1024 * 1024)
          : NaN,
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
              setAdapterId(state.config.adapter?.id ?? 'codex');
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
          <label>
            Coding CLI
            <select
              name="adapter"
              value={adapterId}
              onChange={(event) => {
                const selected = state.adapters.find(
                  (item) => item.id === event.target.value,
                );
                if (selected) setAdapterId(selected.id);
              }}
            >
              {state.adapters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p className="factory-note">
            Selection applies to new release authority. Existing runs and
            repairs keep their pinned CLI and model. Selecting or saving a CLI
            does not launch it.
          </p>
          <div key={adapterId} className="factory-coding-fields">
            <label>
              Coding executable
              <input
                name="executable"
                placeholder="Absolute executable path"
                defaultValue={
                  changedAdapter ? '' : (base.config.executable ?? '')
                }
              />
            </label>
            <label>
              Model
              <input
                name="model"
                placeholder="Configured coding model"
                defaultValue={changedAdapter ? '' : (base.config.model ?? '')}
              />
            </label>
            <label>
              Pinned CLI version
              <input
                name="cliVersion"
                required
                defaultValue={
                  changedAdapter
                    ? (adapter?.supportedVersion ?? '')
                    : (base.config.adapter?.cliVersion ??
                      adapter?.supportedVersion ??
                      '')
                }
              />
            </label>
            <label>
              Credential source
              <select
                name="authKind"
                defaultValue={
                  changedAdapter
                    ? adapter?.credentialKinds[0]
                    : (base.config.auth?.kind ?? adapter?.credentialKinds[0])
                }
              >
                {adapter?.credentialKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind === 'api-key'
                      ? 'API key environment reference'
                      : 'Auth file environment reference'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Environment variable name
              <input
                name="authEnv"
                placeholder="CODING_AUTH_REFERENCE"
                defaultValue={
                  changedAdapter ? '' : (base.config.auth?.env ?? '')
                }
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
          <button disabled={stale || !adapter || unavailable}>
            {busy ? 'Saving coding settings…' : 'Save coding settings'}
          </button>
        </fieldset>
      </form>
    </div>
  );
}
