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
import { WorkflowObservabilityPanelPlugin } from './WorkflowObservabilityPanel';
import type { DisplayPlugin } from '../types';

export const plugins = [
  ReviewsPanelPlugin,
  GitHubPrListPlugin,
  ActiveWatchesPlugin,
  ReportsPanelPlugin,
  RuntimeOverviewPlugin,
  BriefingPanelPlugin,
  MemoryPanelPlugin,
  LearningOperatorPanelPlugin,
  SubagentSummaryPlugin,
  WorkflowObservabilityPanelPlugin,
  FlueChatPlugin,
  HostMetricsPlugin,
  ClockStatusPlugin,
] satisfies DisplayPlugin<any>[];

export const pluginRegistry = Object.fromEntries(
  plugins.map((plugin) => [plugin.id, plugin]),
) as Record<string, DisplayPlugin<any>>;

export function resolvePluginConfig<TConfig extends Record<string, unknown>>(
  plugin: DisplayPlugin<TConfig>,
  config: Record<string, unknown> | undefined,
) {
  if (plugin.parseConfig) return plugin.parseConfig(config);

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { config: plugin.defaultConfig, issues: [] };
  }

  return {
    config: { ...plugin.defaultConfig, ...config },
    issues: [],
  };
}
