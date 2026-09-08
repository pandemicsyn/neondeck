import { useState } from 'react';
import { FactoryCodingConfigForm } from './FactoryCodingConfigForm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getFactoryCodingState } from '../../api/factory-coding';

const readinessLabels = {
  disabled: 'Disabled',
  unconfigured: 'Needs configuration',
  'host-unsupported': 'Operating system unsupported',
  'adapter-unavailable': 'Adapter unavailable',
  'credential-unavailable': 'Credential reference unavailable',
  'executable-unresolved': 'Executable unresolved',
  unsupported: 'CLI contract unsupported',
  ready: 'CLI contract ready',
  busy: 'Readiness check deferred',
};

export const factoryCodingStateKey = ['factory-coding-state'];
export function FactoryCodingSetup() {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: factoryCodingStateKey,
    queryFn: ({ signal }) => getFactoryCodingState({ signal }),
    refetchInterval: 15000,
  });
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <section className="factory-coding-setup" aria-label="Local coding setup">
      <div className="factory-toolbar">
        <h2 id="factory-local-coding">Local coding</h2>
        {state.data && (
          <span className="factory-coding-badge">
            {state.data.readiness.status
              ? readinessLabels[state.data.readiness.status]
              : !state.data.config.enabled
                ? 'Disabled'
                : state.data.readiness.ready
                  ? 'Ready'
                  : 'Needs setup'}
          </span>
        )}
        <button
          aria-expanded={editing}
          aria-controls="factory-coding-config"
          onClick={() => {
            setOpened(true);
            setEditing(!editing);
          }}
          disabled={!state.data}
        >
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
            Selected CLI:{' '}
            {state.data.adapters.find(
              (item) => item.id === (state.data.config.adapter?.id ?? 'codex'),
            )?.label ??
              state.data.config.adapter?.id ??
              'Codex'}{' '}
            · Model {state.data.config.model ?? 'not configured'}
          </p>
          <p className="factory-note">
            CLI{' '}
            {state.data.readiness.installedVersion ??
              (state.data.readiness.status === 'executable-unresolved'
                ? 'not detected'
                : state.data.readiness.status === 'unsupported'
                  ? 'version unavailable'
                  : 'not checked')}{' '}
            · Supported {state.data.readiness.supportedVersion}
          </p>
          <p className="factory-note">
            Authentication:{' '}
            {state.data.readiness.authentication ?? 'unverified'}. CLI readiness
            does not establish authenticated execution. Workspace compatibility
            is checked before preparation and launch.
          </p>
          {state.data.adapters.length === 0 && (
            <output>
              Coding adapter metadata is unavailable. Refresh readiness before
              editing selection.
            </output>
          )}
          <details>
            <summary>Registered CLI capabilities</summary>
            {state.data.adapters.map((adapter) => (
              <div key={adapter.id}>
                <h3>{adapter.label}</h3>
                <p>
                  Supported CLI {adapter.supportedVersion} · Contract{' '}
                  {adapter.contractVersion}
                </p>
                <ul>
                  {Object.entries(adapter.capabilities).map(
                    ([name, capability]) => (
                      <li key={name}>
                        {capability.reason} ({capability.status})
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ))}
          </details>
          {opened && (
            <div id="factory-coding-config" hidden={!editing}>
              <FactoryCodingConfigForm
                state={state.data}
                unavailable={!!state.error}
                onSaved={async () => {
                  setEditing(false);
                  setOpened(false);
                  await client.invalidateQueries({
                    queryKey: factoryCodingStateKey,
                  });
                  await client.invalidateQueries({
                    queryKey: ['factory-validation-policy'],
                  });
                }}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
