import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  getAutopilotPrompts,
  getPrReviewPrompts,
  updateAgentModels,
  updateAutopilotPrompt,
  updatePrReviewPrompt,
  updateProvider,
  type AutopilotOwnerPromptMode,
  type AutopilotPromptConfigData,
  type PrReviewPromptConfigData,
  type PrReviewPromptKind,
  type RuntimeStatus,
} from '../../../api';

export function RuntimeConfigControls({
  onRefresh,
  status,
}: {
  onRefresh: () => void;
  status: RuntimeStatus;
}) {
  const [displayAssistant, setDisplayAssistant] = useState(
    status.models.displayAssistant,
  );
  const [displayThinking, setDisplayThinking] = useState(
    status.models.displayAssistantThinkingLevel,
  );
  const [prReviewModel, setPrReviewModel] = useState(
    status.models.prReviewConfigured ? status.models.prReview : '',
  );
  const [prReviewThinking, setPrReviewThinking] = useState(
    status.models.prReviewThinkingLevel,
  );
  const [prReviewTimeoutSeconds, setPrReviewTimeoutSeconds] = useState(
    String(status.models.prReviewTimeoutMs / 1000),
  );
  const [utilityModel, setUtilityModel] = useState(
    status.models.utilityConfigured ? status.models.utility : '',
  );
  const [utilityThinking, setUtilityThinking] = useState(
    status.models.utilityThinkingLevel,
  );
  const [repoResearcher, setRepoResearcher] = useState(
    status.models.subagents.repoResearcher ?? '',
  );
  const [repoThinking, setRepoThinking] = useState(
    status.models.subagentThinkingLevels.repoResearcher ?? 'medium',
  );
  const [ciInvestigator, setCiInvestigator] = useState(
    status.models.subagents.ciInvestigator ?? '',
  );
  const [ciThinking, setCiThinking] = useState(
    status.models.subagentThinkingLevels.ciInvestigator ?? 'medium',
  );
  const [releaseReviewer, setReleaseReviewer] = useState(
    status.models.subagents.releaseReviewer ?? '',
  );
  const [releaseThinking, setReleaseThinking] = useState(
    status.models.subagentThinkingLevels.releaseReviewer ?? 'medium',
  );
  const [providerId, setProviderId] = useState<ModelProviderId>(
    modelProviderId(status.models.displayAssistantProvider),
  );
  const previousDisplayProvider = useRef<ModelProviderId>(
    modelProviderId(status.models.displayAssistantProvider),
  );
  const selectedProvider = providerStatusSummary(status, providerId);
  const [providerEnabled, setProviderEnabled] = useState(
    selectedProvider.enabled,
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(selectedProvider.apiKeyEnv);
  const [organizationIdEnv, setOrganizationIdEnv] = useState(
    selectedProvider.organizationIdEnv ?? '',
  );
  const [modelDirty, setModelDirty] = useState(false);
  const [providerDirty, setProviderDirty] = useState(false);
  const skipModelSyncForStatus = useRef<string | null>(null);
  const skipProviderSyncForStatus = useRef<string | null>(null);
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [modelMessageIsError, setModelMessageIsError] = useState(false);
  const [providerMessageIsError, setProviderMessageIsError] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    if (skipModelSyncForStatus.current === status.fetchedAt) return;
    skipModelSyncForStatus.current = null;
    if (modelDirty || savingModels) return;
    setDisplayAssistant(status.models.displayAssistant);
    setDisplayThinking(status.models.displayAssistantThinkingLevel);
    setPrReviewModel(
      status.models.prReviewConfigured ? status.models.prReview : '',
    );
    setPrReviewThinking(status.models.prReviewThinkingLevel);
    setPrReviewTimeoutSeconds(String(status.models.prReviewTimeoutMs / 1000));
    setUtilityModel(
      status.models.utilityConfigured ? status.models.utility : '',
    );
    setUtilityThinking(status.models.utilityThinkingLevel);
    setRepoResearcher(status.models.subagents.repoResearcher ?? '');
    setRepoThinking(
      status.models.subagentThinkingLevels.repoResearcher ?? 'medium',
    );
    setCiInvestigator(status.models.subagents.ciInvestigator ?? '');
    setCiThinking(
      status.models.subagentThinkingLevels.ciInvestigator ?? 'medium',
    );
    setReleaseReviewer(status.models.subagents.releaseReviewer ?? '');
    setReleaseThinking(
      status.models.subagentThinkingLevels.releaseReviewer ?? 'medium',
    );
    const nextDisplayProvider = modelProviderId(
      status.models.displayAssistantProvider,
    );
    if (previousDisplayProvider.current !== nextDisplayProvider) {
      previousDisplayProvider.current = nextDisplayProvider;
      setProviderId(nextDisplayProvider);
    }
  }, [modelDirty, savingModels, status]);

  useEffect(() => {
    if (skipProviderSyncForStatus.current === status.fetchedAt) return;
    skipProviderSyncForStatus.current = null;
    if (providerDirty || savingProvider) return;
    const provider = providerStatusSummary(status, providerId);
    setProviderEnabled(provider.enabled);
    setApiKeyEnv(provider.apiKeyEnv);
    setOrganizationIdEnv(provider.organizationIdEnv ?? '');
  }, [providerDirty, providerId, savingProvider, status]);

  async function saveModels(event: FormEvent) {
    event.preventDefault();
    setSavingModels(true);
    setModelMessage(null);
    setModelMessageIsError(false);

    try {
      const parsedPrReviewTimeoutSeconds = Number(prReviewTimeoutSeconds);
      if (
        !Number.isInteger(parsedPrReviewTimeoutSeconds) ||
        parsedPrReviewTimeoutSeconds < minPrReviewTimeoutSeconds ||
        parsedPrReviewTimeoutSeconds > maxPrReviewTimeoutSeconds
      ) {
        setModelMessageIsError(true);
        setModelMessage(
          `Review timeout must be a whole number from ${minPrReviewTimeoutSeconds} to ${maxPrReviewTimeoutSeconds} seconds.`,
        );
        return;
      }
      const input = modelUpdateInput(status, {
        displayAssistant,
        displayThinking,
        prReviewModel,
        prReviewThinking,
        prReviewTimeoutSeconds: parsedPrReviewTimeoutSeconds,
        utilityModel,
        utilityThinking,
        repoResearcher,
        repoThinking,
        ciInvestigator,
        ciThinking,
        releaseReviewer,
        releaseThinking,
      });

      if (Object.keys(input).length === 0) {
        setModelMessage('No model changes to save.');
        return;
      }

      const result = await updateAgentModels(input);
      setModelMessage(result.message);
      skipModelSyncForStatus.current = status.fetchedAt;
      setModelDirty(false);
      onRefresh();
    } catch (cause) {
      setModelMessageIsError(true);
      setModelMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingModels(false);
    }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setSavingProvider(true);
    setProviderMessage(null);
    setProviderMessageIsError(false);

    try {
      const result = await updateProvider(providerId, {
        enabled: providerEnabled,
        apiKeyEnv: apiKeyEnv.trim() || null,
        ...(providerId === 'kilocode'
          ? { organizationIdEnv: organizationIdEnv.trim() || null }
          : {}),
      });
      setProviderMessage(result.message);
      skipProviderSyncForStatus.current = status.fetchedAt;
      setProviderDirty(false);
      onRefresh();
    } catch (cause) {
      setProviderMessageIsError(true);
      setProviderMessage(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSavingProvider(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <form
        className="space-y-2 border border-line bg-soft px-2.5 py-2"
        onSubmit={saveModels}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
            MODELS
          </p>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={savingModels}
            type="submit"
          >
            {savingModels ? 'saving' : 'save'}
          </button>
        </div>
        <ConfigInput
          label="display"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setDisplayAssistant(value);
          }}
          value={displayAssistant}
        />
        <ConfigSelect
          label="display think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setDisplayThinking(value);
          }}
          options={thinkingLevelOptions}
          value={displayThinking}
        />
        <ConfigInput
          label="PR review"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setPrReviewModel(value);
          }}
          placeholder={status.models.prReview}
          value={prReviewModel}
        />
        <ConfigSelect
          label="review think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setPrReviewThinking(value);
          }}
          options={thinkingLevelOptions}
          value={prReviewThinking}
        />
        <ConfigInput
          label="timeout (s)"
          max={maxPrReviewTimeoutSeconds}
          min={minPrReviewTimeoutSeconds}
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setPrReviewTimeoutSeconds(value);
          }}
          step={1}
          type="number"
          value={prReviewTimeoutSeconds}
        />
        <ConfigInput
          label="utility"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setUtilityModel(value);
          }}
          placeholder={status.models.utility}
          value={utilityModel}
        />
        <ConfigSelect
          label="utility think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setUtilityThinking(value);
          }}
          options={thinkingLevelOptions}
          value={utilityThinking}
        />
        <ConfigInput
          label="repo"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setRepoResearcher(value);
          }}
          value={repoResearcher}
        />
        <ConfigSelect
          label="repo think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setRepoThinking(value);
          }}
          options={thinkingLevelOptions}
          value={repoThinking}
        />
        <ConfigInput
          label="ci"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setCiInvestigator(value);
          }}
          value={ciInvestigator}
        />
        <ConfigSelect
          label="ci think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setCiThinking(value);
          }}
          options={thinkingLevelOptions}
          value={ciThinking}
        />
        <ConfigInput
          label="release"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setReleaseReviewer(value);
          }}
          value={releaseReviewer}
        />
        <ConfigSelect
          label="release think"
          onChange={(value) => {
            skipModelSyncForStatus.current = null;
            setModelDirty(true);
            setReleaseThinking(value);
          }}
          options={thinkingLevelOptions}
          value={releaseThinking}
        />
        {modelMessage ? (
          <ConfigMessage error={modelMessageIsError} message={modelMessage} />
        ) : null}
      </form>
      <form
        className="space-y-2 border border-line bg-soft px-2.5 py-2"
        onSubmit={saveProvider}
      >
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-violet">
            <input
              checked={providerEnabled}
              className="size-3 accent-current"
              onChange={(event) => {
                skipProviderSyncForStatus.current = null;
                setProviderDirty(true);
                setProviderEnabled(event.target.checked);
              }}
              type="checkbox"
            />
            PROVIDER TARGET
          </label>
          <select
            aria-label="Provider to configure"
            className="border border-line bg-field px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-violet"
            onChange={(event) => {
              skipProviderSyncForStatus.current = null;
              setProviderDirty(false);
              setProviderId(modelProviderId(event.target.value));
            }}
            value={providerId}
          >
            <option value="kilocode">KiloCode</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={savingProvider}
            type="submit"
          >
            {savingProvider ? 'saving' : 'save'}
          </button>
        </div>
        <ConfigInput
          label="key env"
          onChange={(value) => {
            skipProviderSyncForStatus.current = null;
            setProviderDirty(true);
            setApiKeyEnv(value);
          }}
          value={apiKeyEnv}
        />
        {providerId === 'kilocode' ? (
          <ConfigInput
            label="org env"
            onChange={(value) => {
              skipProviderSyncForStatus.current = null;
              setProviderDirty(true);
              setOrganizationIdEnv(value);
            }}
            placeholder="optional"
            value={organizationIdEnv}
          />
        ) : null}
        <p className="line-clamp-2 text-[10.5px] leading-4 text-muted">
          Environment variable references only. Provider registration changes
          apply after server restart.
        </p>
        {providerMessage ? (
          <ConfigMessage
            error={providerMessageIsError}
            message={providerMessage}
          />
        ) : null}
      </form>
      <PrReviewPromptControls />
      <AutopilotPromptControls />
    </div>
  );
}

export function PrReviewPromptControls() {
  const [data, setData] = useState<PrReviewPromptConfigData | null>(null);
  const [kind, setKind] = useState<PrReviewPromptKind>(
    initialPrReviewPromptKind,
  );
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void getPrReviewPrompts()
      .then((result) => {
        if (!active) return;
        setData(result.data);
        setPrompt(result.data.prompts[initialPrReviewPromptKind]);
      })
      .catch((cause) => {
        if (!active) return;
        setError(true);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function selectKind(nextKind: PrReviewPromptKind) {
    setKind(nextKind);
    setPrompt(data?.prompts[nextKind] ?? '');
    setDirty(false);
    setMessage(null);
    setError(false);
  }

  async function persist(nextPrompt: string | null) {
    setSaving(true);
    setMessage(null);
    setError(false);
    try {
      const result = await updatePrReviewPrompt({ kind, prompt: nextPrompt });
      setData(result.data);
      setPrompt(result.data.prompts[kind]);
      setDirty(false);
      setMessage(result.message);
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2 border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
          PR REVIEW PROMPT
        </p>
        <div className="flex items-center gap-1">
          <button
            className="border border-line px-2 py-1 font-mono text-[10px] text-muted disabled:opacity-50"
            disabled={loading || saving || !data?.overrides[kind]}
            onClick={() => void persist(null)}
            type="button"
          >
            reset default
          </button>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={loading || saving || !dirty || !prompt.trim()}
            onClick={() => void persist(prompt)}
            type="button"
          >
            {saving ? 'saving' : 'save'}
          </button>
        </div>
      </div>
      <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
        <span>prompt</span>
        <select
          aria-label="PR review prompt kind"
          className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
          disabled={loading || saving}
          onChange={(event) =>
            selectKind(event.target.value as PrReviewPromptKind)
          }
          value={kind}
        >
          <option value="initial-review">initial review run</option>
          <option value="follow-up-reviewer">follow-up conversation</option>
        </select>
      </label>
      <textarea
        aria-label="PR review prompt"
        className="min-h-64 w-full resize-y border border-line bg-field px-2 py-1.5 font-mono text-[10.5px] leading-4 text-ink outline-none focus:border-violet disabled:opacity-50"
        disabled={loading || saving}
        maxLength={40_000}
        onChange={(event) => {
          setPrompt(event.target.value);
          setDirty(true);
          setMessage(null);
        }}
        placeholder={
          loading ? 'loading prompt…' : 'Enter reviewer instructions'
        }
        spellCheck={false}
        value={prompt}
      />
      <p className="text-[10.5px] leading-4 text-muted">
        {kind === 'initial-review'
          ? 'Complete replacement system instructions for new review runs. PR facts and the structured result contract are supplied separately.'
          : 'Complete replacement system instructions for reviewer chat. Changes apply on the next turn, including existing conversations.'}
      </p>
      {data?.tokens[kind].length ? (
        <p className="break-words font-mono text-[9.5px] leading-4 text-muted opacity-80">
          tokens · {data.tokens[kind].join(' · ')}
        </p>
      ) : null}
      {message ? <ConfigMessage error={error} message={message} /> : null}
    </section>
  );
}

export function AutopilotPromptControls() {
  const [data, setData] = useState<AutopilotPromptConfigData | null>(null);
  const [mode, setMode] = useState<AutopilotOwnerPromptMode>(
    initialAutopilotPromptMode,
  );
  const [prompt, setPrompt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void getAutopilotPrompts()
      .then((result) => {
        if (!active) return;
        setData(result.data);
        setPrompt(result.data.prompts[initialAutopilotPromptMode]);
      })
      .catch((cause) => {
        if (!active) return;
        setError(true);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function selectMode(nextMode: AutopilotOwnerPromptMode) {
    setMode(nextMode);
    setPrompt(data?.prompts[nextMode] ?? '');
    setDirty(false);
    setMessage(null);
    setError(false);
  }

  async function persist(nextPrompt: string | null) {
    setSaving(true);
    setMessage(null);
    setError(false);
    try {
      const result = await updateAutopilotPrompt({ mode, prompt: nextPrompt });
      setData(result.data);
      setPrompt(result.data.prompts[mode]);
      setDirty(false);
      setMessage(result.message);
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2 border border-line bg-soft px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
          AUTOPILOT OWNER PROMPT
        </p>
        <div className="flex items-center gap-1">
          <button
            className="border border-line px-2 py-1 font-mono text-[10px] text-muted disabled:opacity-50"
            disabled={loading || saving || !data?.overrides[mode]}
            onClick={() => void persist(null)}
            type="button"
          >
            reset default
          </button>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={loading || saving || !dirty || !prompt.trim()}
            onClick={() => void persist(prompt)}
            type="button"
          >
            {saving ? 'saving' : 'save'}
          </button>
        </div>
      </div>
      <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
        <span>mode</span>
        <select
          aria-label="Autopilot prompt mode"
          className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
          disabled={loading || saving}
          onChange={(event) =>
            selectMode(event.target.value as AutopilotOwnerPromptMode)
          }
          value={mode}
        >
          <option value="prepare-only">prepare commit · no delivery</option>
          <option value="autofix-with-approval">
            fix and await human delivery
          </option>
          <option value="autofix-push-when-safe">
            autonomous judgment + delivery
          </option>
        </select>
      </label>
      <textarea
        aria-label="Autopilot owner prompt"
        className="min-h-64 w-full resize-y border border-line bg-field px-2 py-1.5 font-mono text-[10.5px] leading-4 text-ink outline-none focus:border-violet disabled:opacity-50"
        disabled={loading || saving}
        maxLength={20_000}
        onChange={(event) => {
          setPrompt(event.target.value);
          setDirty(true);
          setMessage(null);
        }}
        placeholder={loading ? 'loading prompt…' : 'Enter owner instructions'}
        spellCheck={false}
        value={prompt}
      />
      <p className="text-[10.5px] leading-4 text-muted">
        Full owner system instructions. Changes apply on the next turn,
        including existing owners. Notify-only has no prompt because it does not
        start an owner turn.
      </p>
      {data ? (
        <p className="break-words font-mono text-[9.5px] leading-4 text-muted opacity-80">
          tokens · {data.tokens.join(' · ')}
        </p>
      ) : null}
      {message ? <ConfigMessage error={error} message={message} /> : null}
    </section>
  );
}

const initialAutopilotPromptMode = 'prepare-only' as const;
const initialPrReviewPromptKind = 'initial-review' as const;

function modelUpdateInput(
  status: RuntimeStatus,
  values: {
    displayAssistant: string;
    displayThinking: string;
    prReviewModel: string;
    prReviewThinking: string;
    prReviewTimeoutSeconds: number;
    utilityModel: string;
    utilityThinking: string;
    repoResearcher: string;
    repoThinking: string;
    ciInvestigator: string;
    ciThinking: string;
    releaseReviewer: string;
    releaseThinking: string;
  },
) {
  const displayAssistant = values.displayAssistant.trim();
  const displayThinking = values.displayThinking.trim();
  const prReviewModel = values.prReviewModel.trim();
  const prReviewThinking = values.prReviewThinking.trim();
  const prReviewTimeoutMs = values.prReviewTimeoutSeconds * 1000;
  const utilityModel = values.utilityModel.trim();
  const utilityThinking = values.utilityThinking.trim();
  const repoResearcher = values.repoResearcher.trim();
  const repoThinking = values.repoThinking.trim();
  const ciInvestigator = values.ciInvestigator.trim();
  const ciThinking = values.ciThinking.trim();
  const releaseReviewer = values.releaseReviewer.trim();
  const releaseThinking = values.releaseThinking.trim();
  const subagents: Record<string, string> = {};
  const input: {
    displayAssistant?: string;
    displayAssistantThinkingLevel?: string;
    prReview?: string | null;
    prReviewThinkingLevel?: string;
    prReviewTimeoutMs?: number;
    utility?: string | null;
    utilityThinkingLevel?: string;
    subagents?: Record<string, string>;
  } = {};

  if (displayAssistant !== status.models.displayAssistant) {
    input.displayAssistant = displayAssistant;
  }
  if (displayThinking !== status.models.displayAssistantThinkingLevel) {
    input.displayAssistantThinkingLevel = displayThinking;
  }
  if (prReviewModel) {
    if (
      !status.models.prReviewConfigured ||
      prReviewModel !== status.models.prReview
    ) {
      input.prReview = prReviewModel;
    }
  } else if (status.models.prReviewConfigured) {
    input.prReview = null;
  }
  if (prReviewThinking !== status.models.prReviewThinkingLevel) {
    input.prReviewThinkingLevel = prReviewThinking;
  }
  if (prReviewTimeoutMs !== status.models.prReviewTimeoutMs) {
    input.prReviewTimeoutMs = prReviewTimeoutMs;
  }
  if (utilityModel) {
    if (
      !status.models.utilityConfigured ||
      utilityModel !== status.models.utility
    ) {
      input.utility = utilityModel;
    }
  } else if (status.models.utilityConfigured) {
    input.utility = null;
  }
  if (utilityThinking !== status.models.utilityThinkingLevel) {
    input.utilityThinkingLevel = utilityThinking;
  }

  if (repoResearcher !== status.models.subagents.repoResearcher) {
    subagents.repoResearcher = repoResearcher;
  }
  if (repoThinking !== status.models.subagentThinkingLevels.repoResearcher) {
    subagents.repoResearcherThinkingLevel = repoThinking;
  }
  if (ciInvestigator !== status.models.subagents.ciInvestigator) {
    subagents.ciInvestigator = ciInvestigator;
  }
  if (ciThinking !== status.models.subagentThinkingLevels.ciInvestigator) {
    subagents.ciInvestigatorThinkingLevel = ciThinking;
  }
  if (releaseReviewer !== status.models.subagents.releaseReviewer) {
    subagents.releaseReviewer = releaseReviewer;
  }
  if (
    releaseThinking !== status.models.subagentThinkingLevels.releaseReviewer
  ) {
    subagents.releaseReviewerThinkingLevel = releaseThinking;
  }
  if (Object.keys(subagents).length > 0) {
    input.subagents = subagents;
  }

  return input;
}

function ConfigInput({
  label,
  max,
  min,
  onChange,
  placeholder,
  step,
  type = 'text',
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange: (value: string) => void;
  placeholder?: string;
  step?: number;
  type?: 'number' | 'text';
  value: string;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
      <span className="truncate">{label}</span>
      <input
        className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        step={step}
        type={type}
        value={value}
      />
    </label>
  );
}

function ConfigSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
      <span className="truncate">{label}</span>
      <select
        className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export type ModelProviderId = 'kilocode' | 'openai' | 'anthropic';

const thinkingLevelOptions = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];
const minPrReviewTimeoutSeconds = 10;
const maxPrReviewTimeoutSeconds = 30 * 60;

function modelProviderId(value: string): ModelProviderId {
  if (value === 'openai' || value === 'anthropic') return value;
  return 'kilocode';
}

export function activeModelProviderIds(
  status: RuntimeStatus,
): ModelProviderId[] {
  return Array.from(
    new Set(
      [
        status.models.displayAssistant,
        status.models.utility,
        ...Object.values(status.models.subagents),
      ]
        .map((model) => model.split('/')[0] ?? 'kilocode')
        .map(modelProviderId),
    ),
  );
}

export function providerCredentialConfigured(
  status: RuntimeStatus,
  provider: ModelProviderId,
) {
  if (provider === 'kilocode') return status.providers.credentials.kilo;
  return status.providers.credentials[provider];
}

export function providerStatusSummary(status: RuntimeStatus, provider: string) {
  const id = modelProviderId(provider);
  if (id === 'openai') {
    return {
      label: 'OPENAI',
      enabled: status.providers.configs.openai.enabled,
      apiKeyEnv: status.providers.configs.openai.apiKeyEnv,
      organizationIdEnv: null,
    };
  }

  if (id === 'anthropic') {
    return {
      label: 'ANTHROPIC',
      enabled: status.providers.configs.anthropic.enabled,
      apiKeyEnv: status.providers.configs.anthropic.apiKeyEnv,
      organizationIdEnv: null,
    };
  }

  return {
    label: 'KILOCODE',
    enabled: status.providers.configs.kilocode.enabled,
    apiKeyEnv: status.providers.configs.kilocode.apiKeyEnv,
    organizationIdEnv: status.providers.configs.kilocode.organizationIdEnv,
  };
}

function ConfigMessage({
  error,
  message,
}: {
  error: boolean;
  message: string;
}) {
  return (
    <p
      aria-live={error ? 'assertive' : 'polite'}
      className={`line-clamp-2 border border-line bg-field px-2 py-1 text-[10.5px] leading-4 ${error ? 'text-accent' : 'text-muted'}`}
      role={error ? 'alert' : 'status'}
    >
      {message}
    </p>
  );
}
