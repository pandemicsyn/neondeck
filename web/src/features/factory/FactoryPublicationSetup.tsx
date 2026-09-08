import { useState } from 'react';
import { setupFactoryPublication } from '../../api/factory-delivery';

export function FactoryPublicationSetup({
  repoId,
  workId,
  disabled,
  onSaved,
}: {
  repoId: string;
  workId: string;
  disabled: boolean;
  onSaved: () => Promise<unknown>;
}) {
  const [tokenEnv, setTokenEnv] = useState('GITHUB_TOKEN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <section
      className="factory-publication-setup"
      aria-label="Publication setup"
    >
      <h4>Set up publication for this repository</h4>
      <p>
        Use the registered repository and an existing GitHub credential
        reference. Neon resolves the repository identity. This does not enable
        issue intake or webhooks.
      </p>
      <form
        className="factory-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || disabled || !tokenEnv.trim()) return;
          setBusy(true);
          setError('');
          setSaved(false);
          void setupFactoryPublication(repoId, tokenEnv.trim())
            .then(async () => {
              setSaved(true);
              await onSaved();
            })
            .catch((cause: unknown) => {
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'Publication setup failed. Review the registered repository and credential reference before retrying.',
              );
            })
            .finally(() => setBusy(false));
        }}
      >
        <p>
          Registered repository: <strong>{repoId}</strong>
        </p>
        <label>
          GitHub credential environment reference
          <input
            value={tokenEnv}
            disabled={disabled || busy}
            onChange={(event) => setTokenEnv(event.target.value)}
            placeholder="GITHUB_TOKEN"
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <p>Enter the environment variable name, not the token value.</p>
        {error && (
          <p role="alert" className="factory-error">
            {error}
          </p>
        )}
        {saved && (
          <output>
            Publication setup saved. Review the refreshed publication decision.
          </output>
        )}
        <button disabled={disabled || busy || !tokenEnv.trim()} type="submit">
          {busy ? 'Saving publication setup…' : 'Save publication setup'}
        </button>
        <a href={`/factory?task=${encodeURIComponent(workId)}`}>
          Return to this task
        </a>
      </form>
    </section>
  );
}
