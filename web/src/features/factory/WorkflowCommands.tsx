import { useId } from 'react';
import type { RepoWorkflowCommand } from '../../../../shared/repo-workflows';

export function WorkflowCommands({
  phase,
  commands,
  onChange,
}: {
  phase: 'Setup' | 'Check';
  commands: RepoWorkflowCommand[];
  onChange: (commands: RepoWorkflowCommand[]) => void;
}) {
  const id = useId();
  return (
    <fieldset className="workflow-commands">
      <legend>{phase} commands</legend>
      <p>
        {phase === 'Setup'
          ? 'Prepare dependencies before running checks.'
          : 'Verify the prepared repository. Required repository checks also run.'}{' '}
        Commands run in order. Each entry is one invocation. Add another command
        for the next step; use a repository script for complex steps.
      </p>
      {!commands.length && (
        <p>
          {phase === 'Setup'
            ? 'No setup commands. Add one if dependencies need installing.'
            : 'No profile checks. Add the commands that verify this repository.'}
        </p>
      )}
      {commands.map((item, index) => (
        <div className="workflow-command" key={`${id}-${index}`}>
          <label htmlFor={`${id}-${index}-command`}>
            {phase} command {index + 1}
            <textarea
              id={`${id}-${index}-command`}
              rows={2}
              required
              value={item.command}
              spellCheck={false}
              onChange={(event) =>
                onChange(
                  commands.map((command, i) =>
                    i === index
                      ? { ...command, command: event.target.value }
                      : command,
                  ),
                )
              }
            />
          </label>
          <label htmlFor={`${id}-${index}-cwd`}>
            Working directory
            <input
              id={`${id}-${index}-cwd`}
              required
              value={item.cwd}
              placeholder=". or web"
              spellCheck={false}
              onChange={(event) =>
                onChange(
                  commands.map((command, i) =>
                    i === index
                      ? { ...command, cwd: event.target.value }
                      : command,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            aria-label={`Remove ${phase.toLowerCase()} command ${index + 1}`}
            onClick={() => onChange(commands.filter((_, i) => i !== index))}
          >
            Remove command
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={commands.length >= 16}
        onClick={() => onChange([...commands, { command: '', cwd: '.' }])}
      >
        Add {phase.toLowerCase()} command
      </button>
      <p className="factory-note">
        Directories are relative to the repository. Use . for its root.
      </p>
    </fieldset>
  );
}
