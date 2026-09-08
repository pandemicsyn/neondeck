import * as v from 'valibot';
import type { validationPolicySchema } from '../../../../shared/factory-delivery';
import { getFactoryValidationPolicy } from '../../api/factory-delivery';
import { useFactoryRefresh } from './useFactoryRefresh';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FactoryCodingState } from '../../../../shared/factory-coding';
import { getFactoryCodingState } from '../../api/factory-coding';

interface ReleaseCodingProps {
  label: string;
  repoId?: string;
  disabled: boolean;
  releaseNotice?: ReactNode;
  onRelease: (
    fingerprint: string,
    validationPolicy: v.InferOutput<typeof validationPolicySchema>,
  ) => void;
}

/** Owns the visible execution snapshot and the authority submitted with it. */
export function FactoryReleaseCoding(props: ReleaseCodingProps) {
  const { refreshing, refresh } = useFactoryRefresh();
  const validation = useQuery({
    queryKey: ['factory-validation-policy', props.repoId],
    queryFn: ({ signal }) =>
      getFactoryValidationPolicy(props.repoId!, { signal }),
    enabled: !!props.repoId,
    refetchInterval: 15000,
    retry: false,
  });
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
          disabled={query.isPending || refreshing}
          onClick={() =>
            void refresh(() =>
              Promise.all([
                query.refetch(),
                props.repoId ? validation.refetch() : Promise.resolve(),
              ]),
            )
          }
        >
          {query.isPending || refreshing
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
      {props.repoId && validation.error && (
        <div role="alert" className="factory-error">
          {validation.error.message}
          <p>
            Configure the independent PR review model and repository check
            commands before approving this plan. Your task and draft stay open
            here.
          </p>
          <a
            href="/?panel=runtime-overview#runtime-model-config"
            target="_blank"
            rel="noreferrer"
          >
            Open model configuration
          </a>
          {' · '}
          <a
            href="/?panel=runtime-overview#runtime-repositories"
            target="_blank"
            rel="noreferrer"
          >
            Open registered repositories
          </a>
          <p>
            Use the repository conversation to configure its check commands,
            then refresh these execution settings.
          </p>
          <button onClick={() => void validation.refetch()}>
            Reload validation policy
          </button>
        </div>
      )}
      {query.data && (
        <ReleaseSnapshot
          {...props}
          current={query.data}
          validationPolicy={validation.data}
          validationUnavailable={
            !!props.repoId && (validation.isPending || !!validation.error)
          }
          unavailable={!!query.error || query.isPending || refreshing}
        />
      )}
    </section>
  );
}

function ReleaseSnapshot({
  current,
  validationPolicy,
  validationUnavailable,
  unavailable,
  label,
  disabled,
  releaseNotice,
  onRelease,
}: ReleaseCodingProps & {
  validationPolicy?: v.InferOutput<typeof validationPolicySchema>;
  validationUnavailable: boolean;
  current: FactoryCodingState;
  unavailable: boolean;
}) {
  const noticeId = useId();
  const [reviewed, setReviewed] = useState(current);
  const stale = reviewed.configFingerprint !== current.configFingerprint;
  const [retainedValidation, setReviewedValidation] =
    useState(validationPolicy);
  const reviewedValidation = retainedValidation ?? validationPolicy;
  useEffect(() => {
    if (!retainedValidation && validationPolicy)
      setReviewedValidation(validationPolicy);
  }, [retainedValidation, validationPolicy]);
  const validationStale =
    !!validationPolicy &&
    JSON.stringify(reviewedValidation) !== JSON.stringify(validationPolicy);
  const blocked =
    unavailable ||
    validationUnavailable ||
    validationStale ||
    !reviewedValidation;
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
    repositorySkills: [
      [
        'Repository skills',
        config.repositorySkills === 'native-v1'
          ? 'Native CLI discovery'
          : 'Legacy discovery policy',
      ],
    ],
  } satisfies Record<keyof FactoryCodingState['config'], [string, string][]>;
  return (
    <>
      <p>
        This release authorizes the exact execution settings below. Credential
        names are references only; credential values are never shown. The
        permission profile is not an OS sandbox.
      </p>
      {validationStale && (
        <p>
          Validation policy changed or became available.{' '}
          <button
            disabled={validationUnavailable || disabled}
            onClick={() => setReviewedValidation(validationPolicy)}
          >
            Review validation policy
          </button>
        </p>
      )}
      {reviewedValidation && (
        <section aria-label="Validation allowance">
          <p>
            Approving this plan starts coding, then automatic local checks and
            independent review, with at most{' '}
            {reviewedValidation.maxRepairAttempts} scoped repairs and{' '}
            {Math.ceil(reviewedValidation.totalExecutionMs / 3600000)} hours
            cumulative execution. Creating a draft PR needs a separate approval.
          </p>
          <p>Independent reviewer: {reviewedValidation.reviewerModel}</p>
          <details>
            <summary>Approved validation commands</summary>
            <ul>
              {reviewedValidation.checkCommands.map((command) => (
                <li key={command}>
                  <code>{command}</code>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
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
      <details>
        <summary>Execution configuration details</summary>
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
      </details>
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
        aria-describedby={disabled || blocked || stale ? noticeId : undefined}
        disabled={disabled || blocked || stale}
        onClick={() => {
          if (!disabled && !blocked && !stale && reviewedValidation)
            onRelease(reviewed.configFingerprint, reviewedValidation);
        }}
      >
        {label}
      </button>
    </>
  );
}
