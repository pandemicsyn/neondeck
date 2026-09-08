import type { LinearConnection } from '../../../../shared/factory-linear';

const lifecycleStates = [
  'inbox',
  'shaping',
  'queued',
  'paused',
  'closed',
] as const;

export function FactoryLinearConnectionForm({
  value,
  onChange,
  repos,
  busy,
  stale,
  onSave,
  onCancel,
}: {
  value: LinearConnection;
  onChange: (value: LinearConnection) => void;
  repos: { id: string; name: string }[];
  busy: boolean;
  stale: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="factory-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <fieldset disabled={busy} className="factory-editor-fields">
        <legend>Linear connection setup</legend>
        {stale && (
          <p role="alert">
            Saved connections changed. Your draft is retained. Copy your
            changes, then cancel and reopen the saved connection.
          </p>
        )}
        {(
          [
            ['id', 'Connection ID'],
            ['organizationId', 'Linear workspace ID'],
            ['teamId', 'Linear team ID'],
          ] as const
        ).map(([field, label]) => (
          <label key={field}>
            {label}
            <input
              required
              value={value[field]}
              onChange={(event) =>
                onChange({ ...value, [field]: event.target.value })
              }
            />
          </label>
        ))}
        <label>
          Linear project ID (optional)
          <input
            value={value.projectId ?? ''}
            onChange={(event) =>
              onChange({ ...value, projectId: event.target.value || null })
            }
          />
        </label>
        <p>
          Leave the project blank to match the entire team. Every admitted issue
          must match one repository unambiguously.
        </p>
        <label>
          Registered repository
          <select
            required
            value={value.repoId}
            onChange={(event) =>
              onChange({ ...value, repoId: event.target.value })
            }
          >
            <option value="">Choose repository</option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ['tokenEnv', 'Linear credential environment reference'],
            ['webhookSecretEnv', 'Webhook secret environment reference'],
          ] as const
        ).map(([field, label]) => (
          <label key={field}>
            {label}
            <input
              required
              pattern="[A-Z][A-Z0-9_]*"
              value={value[field]}
              onChange={(event) =>
                onChange({ ...value, [field]: event.target.value })
              }
            />
          </label>
        ))}
        <p>
          Enter environment variable names only. Store secret values in the
          private runtime environment.
        </p>
        <label>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) =>
              onChange({ ...value, enabled: event.target.checked })
            }
          />
          Enable Linear admission
        </label>
        <label>
          Admit Linear issues
          <select
            value={value.admission.mode}
            onChange={(event) =>
              onChange({
                ...value,
                admission: {
                  mode: event.target
                    .value as LinearConnection['admission']['mode'],
                  ...(value.admission.value
                    ? { value: value.admission.value }
                    : {}),
                },
              })
            }
          >
            <option value="all">All issues in this mapping</option>
            <option value="label">With a specific label ID</option>
            <option value="state">In a specific workflow state ID</option>
          </select>
        </label>
        {value.admission.mode !== 'all' && (
          <label>
            {value.admission.mode === 'label'
              ? 'Admission label ID'
              : 'Admission workflow state ID'}
            <input
              required
              value={value.admission.value ?? ''}
              onChange={(event) =>
                onChange({
                  ...value,
                  admission: { ...value.admission, value: event.target.value },
                })
              }
            />
          </label>
        )}
        <h3>Status writeback</h3>
        <p>
          Off by default. When enabled, factory lifecycle changes can update the
          issue to the configured Linear workflow state IDs. Blank states are
          not published.
        </p>
        <label>
          <input
            type="checkbox"
            checked={value.writeback.enabled}
            onChange={(event) =>
              onChange({
                ...value,
                writeback: {
                  ...value.writeback,
                  enabled: event.target.checked,
                },
              })
            }
          />
          Enable Linear status writeback
        </label>
        {lifecycleStates.map((state) => (
          <label key={state}>
            Linear state ID for {state}
            <input
              value={value.writeback.states[state] ?? ''}
              onChange={(event) => {
                const states = { ...value.writeback.states };
                if (event.target.value) states[state] = event.target.value;
                else delete states[state];
                onChange({
                  ...value,
                  writeback: { ...value.writeback, states },
                });
              }}
            />
          </label>
        ))}
        <div className="factory-toolbar">
          <button disabled={stale}>
            {busy ? 'Saving Linear connection…' : 'Save Linear connection'}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
