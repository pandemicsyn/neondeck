import { ActiveWatchesPlugin } from './ActiveWatches';
import { BriefingPanelPlugin } from './BriefingPanel';
import { ClockStatusPlugin } from './ClockStatus';
import { FlueChatPlugin } from './FlueChat';
import { GitHubPrListPlugin } from './GitHubPrList';
import { HostMetricsPlugin } from './HostMetrics';
import { LearningOperatorPanelPlugin } from './LearningOperatorPanel';
import { MemoryPanelPlugin } from './MemoryPanel';
import { ReportsPanelPlugin } from './ReportsPanel';
import { ReviewsPanelPlugin } from './ReviewsPanel';
import { RuntimeOverviewPlugin } from './RuntimeOverview';
import { SubagentSummaryPlugin } from './SubagentSummary';
import { ActivityPanelPlugin } from './ActivityPanel';
import type { DisplayPlugin } from '../types';
import type { WebExternalValue, WebJsonRecord } from '../api/schemas';
import type { DashboardRegion } from '../api/types';
import type { ReactNode } from 'react';
import { plainConfigRecord } from './config';

type RegisteredPlugin = Pick<DisplayPlugin, 'id' | 'title' | 'kind'> & {
  render(
    region: DashboardRegion,
    config: WebJsonRecord | undefined,
  ): { content: ReactNode; issues: string[] };
};

export const plugins = [
  registerPlugin(ReviewsPanelPlugin),
  registerPlugin(GitHubPrListPlugin),
  registerPlugin(ActiveWatchesPlugin),
  registerPlugin(ReportsPanelPlugin),
  registerPlugin(RuntimeOverviewPlugin),
  registerPlugin(BriefingPanelPlugin),
  registerPlugin(MemoryPanelPlugin),
  registerPlugin(LearningOperatorPanelPlugin),
  registerPlugin(SubagentSummaryPlugin),
  registerPlugin(ActivityPanelPlugin),
  registerPlugin(FlueChatPlugin),
  registerPlugin(HostMetricsPlugin),
  registerPlugin(ClockStatusPlugin),
] as const;

export const pluginRegistry = Object.fromEntries(plugins.map(pluginEntry));

function pluginEntry(plugin: RegisteredPlugin): [string, RegisteredPlugin] {
  return [plugin.id, plugin];
}

function registerPlugin<TConfig extends object>(
  plugin: DisplayPlugin<TConfig>,
): RegisteredPlugin {
  return {
    id: plugin.id,
    title: plugin.title,
    kind: plugin.kind,
    render(region, config) {
      const resolved = resolvePluginConfig(plugin, config);
      const PluginComponent = plugin.Component;
      return {
        issues: resolved.issues,
        content: <PluginComponent config={resolved.config} region={region} />,
      };
    },
  };
}

export function resolvePluginConfig<TConfig extends object>(
  plugin: DisplayPlugin<TConfig>,
  config: WebExternalValue,
) {
  const source = config === undefined ? undefined : plainConfigRecord(config);
  if (plugin.parseConfig) return plugin.parseConfig(source);

  return {
    config: { ...plugin.defaultConfig, ...source },
    issues: [],
  };
}
