import type { RepoWorkflowProfile } from '../../../../shared/repo-workflows';

export function FactoryWorkflowSummary({
  workflow,
}: {
  workflow: RepoWorkflowProfile;
}) {
  return (
    <section aria-label="Approved repository workflow">
      <h4>{workflow.name}</h4>
      <p>
        Saved workflow: <code>{workflow.id}</code>. This exact setup and
        validation snapshot is captured at approval.
      </p>
      {(
        [
          ['Setup', workflow.setupCommands, workflow.setupTimeoutMs],
          [
            'Validation (including required checks)',
            workflow.validationCommands,
            workflow.validationTimeoutMs,
          ],
        ] as const
      ).map(([label, commands, timeout]) => (
        <div key={label}>
          <h5>{label}</h5>
          <p>Time limit: {Math.ceil(timeout / 1000)} seconds.</p>
          {commands.length ? (
            <ol>
              {commands.map((command, index) => (
                <li key={`${index}:${command.cwd}:${command.command}`}>
                  <code
                    style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                  >
                    {command.command}
                  </code>
                  <div>
                    Directory: <code>{command.cwd}</code>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p>No setup commands.</p>
          )}
        </div>
      ))}
      <dl className="factory-coding-facts">
        <div>
          <dt>Node requirement</dt>
          <dd>{workflow.runtime.node ?? 'No version requirement'}</dd>
        </div>
        <div>
          <dt>Package manager</dt>
          <dd>
            {workflow.runtime.packageManager
              ? `${workflow.runtime.packageManager.name} ${workflow.runtime.packageManager.version ?? '(no version requirement)'}`
              : 'No requirement'}
          </dd>
        </div>
        <div>
          <dt>Environment references</dt>
          <dd>
            {workflow.environmentRefs.length
              ? workflow.environmentRefs.join(', ')
              : 'None'}
          </dd>
        </div>
      </dl>
      <p>
        Runtime requirements are checked before setup. Missing runtimes must be
        installed by the operator. Environment values remain private.
      </p>
    </section>
  );
}
