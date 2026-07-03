import type { ComponentType } from 'react';
import type { DashboardRegion } from './api/types';
export type {
  DashboardConfig,
  DashboardDensity,
  DashboardLayoutMode,
  DashboardRegion,
  DashboardStatusline,
  DashboardTab,
  DashboardTheme,
} from './api/types';

export type DisplayPluginProps<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  region: DashboardRegion;
  config: TConfig;
};

export type PluginConfigParseResult<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  config: TConfig;
  issues: string[];
};

export type DisplayPlugin<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  title: string;
  kind: 'data' | 'agent' | 'status';
  defaultConfig: TConfig;
  parseConfig?: (
    config: Record<string, unknown> | undefined,
  ) => PluginConfigParseResult<TConfig>;
  Component: ComponentType<DisplayPluginProps<TConfig>>;
};
