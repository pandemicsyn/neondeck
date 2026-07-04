import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  updateAgentModels,
  updateProvider,
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
  const [savingModels, setSavingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    if (skipModelSyncForStatus.current === status.fetchedAt) return;
    skipModelSyncForStatus.current = null;
    if (modelDirty || savingModels) return;
    setDisplayAssistant(status.models.displayAssistant);
    setDisplayThinking(status.models.displayAssistantThinkingLevel);
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

    try {
      const input = modelUpdateInput(status, {
        displayAssistant,
        displayThinking,
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
      setModelMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingModels(false);
    }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setSavingProvider(true);
    setProviderMessage(null);

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
        {modelMessage ? <ConfigMessage message={modelMessage} /> : null}
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
        {providerMessage ? <ConfigMessage message={providerMessage} /> : null}
      </form>
    </div>
  );
}

function modelUpdateInput(
  status: RuntimeStatus,
  values: {
    displayAssistant: string;
    displayThinking: string;
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
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
      <span className="truncate">{label}</span>
      <input
        className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
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

function ConfigMessage({ message }: { message: string }) {
  return (
    <p className="line-clamp-2 border border-line bg-field px-2 py-1 text-[10.5px] leading-4 text-muted">
      {message}
    </p>
  );
}
