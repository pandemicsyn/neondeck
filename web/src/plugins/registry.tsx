import { ClockStatusPlugin } from './ClockStatus';
import { FlueChatPlugin } from './FlueChat';
import { GitHubPrListPlugin } from './GitHubPrList';
import { HostMetricsPlugin } from './HostMetrics';
import type { DisplayPlugin } from '../types';

export const plugins = [
  GitHubPrListPlugin,
  FlueChatPlugin,
  HostMetricsPlugin,
  ClockStatusPlugin,
] satisfies DisplayPlugin<any>[];

export const pluginRegistry = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin])) as Record<
  string,
  DisplayPlugin<any>
>;
