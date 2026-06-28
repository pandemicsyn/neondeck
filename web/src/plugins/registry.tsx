import { ActiveWatchesPlugin } from './ActiveWatches';
import { BriefingPanelPlugin } from './BriefingPanel';
import { ClockStatusPlugin } from './ClockStatus';
import { FlueChatPlugin } from './FlueChat';
import { GitHubPrListPlugin } from './GitHubPrList';
import { HostMetricsPlugin } from './HostMetrics';
import { MemoryPanelPlugin } from './MemoryPanel';
import { RuntimeOverviewPlugin } from './RuntimeOverview';
import { SubagentSummaryPlugin } from './SubagentSummary';
import type { DisplayPlugin } from '../types';

export const plugins = [
  GitHubPrListPlugin,
  ActiveWatchesPlugin,
  RuntimeOverviewPlugin,
  BriefingPanelPlugin,
  MemoryPanelPlugin,
  SubagentSummaryPlugin,
  FlueChatPlugin,
  HostMetricsPlugin,
  ClockStatusPlugin,
] satisfies DisplayPlugin<any>[];

export const pluginRegistry = Object.fromEntries(
  plugins.map((plugin) => [plugin.id, plugin]),
) as Record<string, DisplayPlugin<any>>;
