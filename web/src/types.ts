import type { ComponentType } from 'react';
import type { DashboardRegion } from './api/types';
import type { WebJsonRecord } from './api/schemas';
export type {
  DashboardConfig,
  DashboardDensity,
  DashboardLayoutMode,
  DashboardRegion,
  DashboardStatusline,
  DashboardTab,
  DashboardTheme,
  DashboardToastConfig,
} from './api/types';

export type DisplayPluginProps<TConfig extends object = object> = {
  region: DashboardRegion;
  config: TConfig;
};

export type PluginConfigParseResult<TConfig extends object = object> = {
  config: TConfig;
  issues: string[];
};

export type DisplayPlugin<TConfig extends object = object> = {
  id: string;
  title: string;
  kind: 'data' | 'agent' | 'status';
  defaultConfig: TConfig;
  parseConfig?: (
    config: WebJsonRecord | undefined,
  ) => PluginConfigParseResult<TConfig>;
  Component: ComponentType<DisplayPluginProps<TConfig>>;
};
