import { useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FactoryCodingState } from '../../../../shared/factory-coding';
import { getFactoryCodingState } from '../../api/factory-coding';

interface ReleaseCodingProps {
  label: string;
  disabled: boolean;
  releaseNotice?: ReactNode;
  onRelease: (fingerprint: string) => void;
}

/** Owns the visible execution snapshot and the authority submitted with it. */
export function FactoryReleaseCoding(props: ReleaseCodingProps) {
  const query = useQuery({
    queryKey: ['factory-coding-state'],
    queryFn: ({ signal }) => getFactoryCodingState({ signal }),
    refetchInterval: 15000,
  });
  return (
    <section aria-label="Review release execution settings">
      <div className="factory-toolbar">
        <h3>Execution settings for this release</h3>
        <button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching
            ? 'Refreshing execution settings…'
            : 'Refresh execution settings'}
        </button>
      </div>
      {query.isPending && <output>Loading release execution settings…</output>}
      {query.error && (
        <p role="alert" className="factory-error">
          Coding selection is unavailable. Retained settings cannot be released
          until a successful refresh.
        </p>
      )}
      {query.data && (
        <ReleaseSnapshot
          {...props}
          current={query.data}
          unavailable={!!query.error || query.isFetching}
        />
      )}
    </section>
  );
}

function ReleaseSnapshot({
  current,
  unavailable,
  label,
  disabled,
  releaseNotice,
  onRelease,
}: ReleaseCodingProps & {
  current: FactoryCodingState;
  unavailable: boolean;
}) {
  const noticeId = useId();
  const [reviewed, setReviewed] = useState(current);
  const stale = reviewed.configFingerprint !== current.configFingerprint;
  const config = reviewed.config;
  const facts = {
    enabled: [['Automatic coding', config.enabled ? 'Enabled' : 'Disabled']],
    adapter: [
      [
        'Coding CLI',
        config.adapter?.id ?? 'codex (default; no adapter override)',
      ],
      [
        'Adapter contract',
        config.adapter
          ? String(config.adapter.contractVersion)
          : 'Default Codex contract',
      ],
      [
        'CLI version',
        config.adapter?.cliVersion ??
          'Default Codex version policy; no override',
      ],
    ],
    executable: [['Executable', config.executable ?? 'Not configured']],
    model: [['Model', config.model ?? 'Not configured']],
    auth: [
      ['Credential kind', config.auth?.kind ?? 'None selected'],
      config.auth?.kind === 'codex-local'
        ? ['Credential file reference', config.auth.path]
        : [
            'Credential environment reference',
            config.auth?.env ?? 'None selected',
          ],
    ],
    path: [['Executable search PATH', config.path]],
    sandbox: [['Permission profile', config.sandbox]],
    wallTimeMs: [
      [
        'Attempt time limit',
        `${config.wallTimeMs} ms (${config.wallTimeMs / 60000} minutes)`,
      ],
    ],
    maxOutputBytes: [['Output limit', `${config.maxOutputBytes} bytes`]],
    maxWriters: [['Maximum writers', String(config.maxWriters)]],
  } satisfies Record<keyof FactoryCodingState['config'], [string, string][]>;
  return (
    <>
      <p>
        This release authorizes the exact execution settings below. Credential
        names are references only; credential values are never shown. The
        permission profile is not an OS sandbox.
      </p>
      {stale && (
        <div className="factory-error">
          <p>
            <output>
              Execution settings changed since this review. The previous
              settings remain visible; release is blocked.
            </output>
          </p>
          <button
            disabled={unavailable || disabled}
            onClick={() => setReviewed(current)}
          >
            Review updated execution settings
          </button>
        </div>
      )}
      <dl className="factory-coding-facts">
        {Object.values(facts)
          .flat()
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <p>
        Later configuration changes require another release. Existing runs and
        grants keep their admitted settings and budgets.
      </p>
      <div id={noticeId}>
        {releaseNotice}
        {unavailable && (
          <p>
            <output>
              Release is unavailable until execution settings finish refreshing
              successfully.
            </output>
          </p>
        )}
        {stale && (
          <p>
            <output>
              Review updated execution settings above before releasing.
            </output>
          </p>
        )}
      </div>
      <button
        aria-describedby={
          disabled || unavailable || stale ? noticeId : undefined
        }
        disabled={disabled || unavailable || stale}
        onClick={() => {
          if (!disabled && !unavailable && !stale)
            onRelease(reviewed.configFingerprint);
        }}
      >
        {label}
      </button>
    </>
  );
}
