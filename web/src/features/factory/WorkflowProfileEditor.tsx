import type { RepoWorkflowProfile } from '../../../../shared/repo-workflows';
import { WorkflowCommands } from './WorkflowCommands';

export function WorkflowProfileEditor({
  profile,
  onChange,
}: {
  profile: RepoWorkflowProfile;
  onChange: (profile: RepoWorkflowProfile) => void;
}) {
  return (
    <div className="workflow-profile">
      <div className="workflow-fields">
        <label>
          Profile ID
          <input
            required
            value={profile.id}
            onChange={(e) => onChange({ ...profile, id: e.target.value })}
          />
        </label>
        <label>
          Profile name
          <input
            required
            value={profile.name}
            onChange={(e) => onChange({ ...profile, name: e.target.value })}
          />
        </label>
      </div>
      <WorkflowCommands
        phase="Setup"
        commands={profile.setupCommands}
        onChange={(setupCommands) => onChange({ ...profile, setupCommands })}
      />
      <WorkflowCommands
        phase="Check"
        commands={profile.validationCommands}
        onChange={(validationCommands) =>
          onChange({ ...profile, validationCommands })
        }
      />
      <div className="workflow-fields">
        <label>
          Setup time limit (seconds)
          <input
            type="number"
            min={1}
            max={3600}
            required
            value={profile.setupTimeoutMs / 1000}
            onChange={(e) =>
              onChange({
                ...profile,
                setupTimeoutMs: Number(e.target.value) * 1000,
              })
            }
          />
        </label>
        <label>
          Checks time limit (seconds)
          <input
            type="number"
            min={1}
            max={3600}
            required
            value={profile.validationTimeoutMs / 1000}
            onChange={(e) =>
              onChange({
                ...profile,
                validationTimeoutMs: Number(e.target.value) * 1000,
              })
            }
          />
        </label>
      </div>
      <fieldset>
        <legend>Runtime requirements</legend>
        <p>
          These requirements are checked against the installed runtime. They do
          not install tools.
        </p>
        <div className="workflow-fields">
          <label>
            Node version requirement
            <input
              value={profile.runtime.node ?? ''}
              placeholder=">=26"
              onChange={(e) =>
                onChange({
                  ...profile,
                  runtime: {
                    ...profile.runtime,
                    node: e.target.value || undefined,
                  },
                })
              }
            />
          </label>
          <label>
            Package manager
            <select
              value={profile.runtime.packageManager?.name ?? ''}
              onChange={(e) =>
                onChange({
                  ...profile,
                  runtime: {
                    ...profile.runtime,
                    packageManager: e.target.value
                      ? {
                          name: e.target.value as
                            'npm' | 'pnpm' | 'yarn' | 'bun',
                          version: profile.runtime.packageManager?.version,
                        }
                      : undefined,
                  },
                })
              }
            >
              <option value="">No requirement</option>
              {['npm', 'pnpm', 'yarn', 'bun'].map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          {profile.runtime.packageManager && (
            <label>
              Package manager version
              <input
                value={profile.runtime.packageManager.version ?? ''}
                placeholder="Optional requirement"
                onChange={(e) =>
                  onChange({
                    ...profile,
                    runtime: {
                      ...profile.runtime,
                      packageManager: {
                        ...profile.runtime.packageManager!,
                        version: e.target.value || undefined,
                      },
                    },
                  })
                }
              />
            </label>
          )}
        </div>
      </fieldset>
      <label>
        Environment variable references
        <textarea
          rows={3}
          value={profile.environmentRefs.join('\n')}
          placeholder={'NPM_TOKEN\nCI_TOKEN'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) =>
            onChange({
              ...profile,
              environmentRefs: e.target.value.split('\n'),
            })
          }
        />
      </label>
      <p>
        Enter one variable name per line, never a secret value. Values are read
        from the private runtime environment.
      </p>
    </div>
  );
}
