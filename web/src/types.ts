import type { ComponentType } from 'react';

export type DashboardTheme = 'light' | 'dark' | 'system';

export type DashboardConfig = {
  display: {
    width: number;
    height: number;
  };
  theme: DashboardTheme;
  layout: {
    columns: number;
    rows: number;
    regions: DashboardRegion[];
  };
};

export type DashboardRegion = {
  id: string;
  title: string;
  pluginId: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  config: Record<string, unknown>;
};

export type DisplayPluginProps<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  region: DashboardRegion;
  config: TConfig;
};

export type DisplayPlugin<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  id: string;
  title: string;
  kind: 'data' | 'agent' | 'status';
  defaultConfig: TConfig;
  Component: ComponentType<DisplayPluginProps<TConfig>>;
};
