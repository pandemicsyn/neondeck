import type { ComponentType } from 'react';

export type DashboardTheme = 'light' | 'dark' | 'system';
export type DashboardDensity = 'compact' | 'comfortable' | 'large';
export type DashboardLayoutMode = 'auto' | 'xeneon' | 'stacked';

export type DashboardConfig = {
  $schema?: string;
  display: {
    preset?: string;
    width: number;
    height: number;
  };
  theme: DashboardTheme;
  appearance?: {
    density?: DashboardDensity;
    textScale?: number;
  };
  statusline?: DashboardStatusline;
  layout: {
    mode?: DashboardLayoutMode;
    columns: number;
    rows: number;
    regions: DashboardRegion[];
  };
};

export type DashboardStatusline = {
  position: 'top' | 'bottom';
  pluginId: string;
  config?: Record<string, unknown>;
};

export type DashboardRegion = {
  id: string;
  title: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  defaultTab?: string;
  tabs: DashboardTab[];
};

export type DashboardTab = {
  id: string;
  title: string;
  pluginId: string;
  config?: Record<string, unknown>;
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
