import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getDashboardConfig, openConfigEventStream } from './api';
import { Card } from './components/ui';
import {
  configEventTouchesFile,
  dispatchConfigChangeEvent,
} from './lib/config-events';
import { queryErrorMessage, queryKeys } from './lib/query';
import { pluginRegistry } from './plugins/registry';
import type {
  DashboardConfig,
  DashboardRegion,
  DashboardStatusline,
  DashboardTab,
  DashboardTheme,
} from './types';

export function App() {
  const queryClient = useQueryClient();
  const {
    data: config,
    error,
    isLoading,
  } = useQuery({
    queryKey: queryKeys.dashboardConfig,
    queryFn: getDashboardConfig,
  });

  useEffect(() => {
    return openConfigEventStream((event) => {
      dispatchConfigChangeEvent(event);
      if (
        event.action === 'config_reload' ||
        configEventTouchesFile(event, 'dashboard.json')
      ) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardConfig,
        });
      }
    });
  }, [queryClient]);

  useEffect(() => {
    if (!config) return;
    const resolved = resolveTheme(config.theme);
    document.documentElement.dataset.theme = resolved;
  }, [config]);

  if (error) {
    return (
      <BootState
        title="Dashboard config failed"
        detail={queryErrorMessage(error)}
      />
    );
  }

  if (isLoading || !config) {
    return (
      <BootState
        title="Starting dashboard"
        detail="Loading local layout config."
      />
    );
  }

  return (
    <main className="deck-page h-screen overflow-hidden bg-bg text-ink">
      <DashboardShell config={config} />
    </main>
  );
}

function DashboardShell({ config }: { config: DashboardConfig }) {
  const gridStyle = useMemo(
    () => ({
      gridTemplateColumns: `repeat(${config.layout.columns}, minmax(0, 1fr))`,
      gridTemplateRows: config.statusline
        ? statuslineRows(config)
        : `repeat(${config.layout.rows}, minmax(0, 1fr))`,
    }),
    [config],
  );
  const rowOffset = config.statusline?.position === 'top' ? 1 : 0;

  return (
    <section className="deck-shell h-screen w-screen overflow-hidden bg-bg p-0">
      <div
        className="dashboard-grid grid h-full w-full gap-0 border-0 bg-canvas p-0"
        style={gridStyle}
      >
        {config.statusline ? (
          <StatuslinePanel
            columns={config.layout.columns}
            rows={config.layout.rows}
            statusline={config.statusline}
          />
        ) : null}
        {config.layout.regions.map((region) => (
          <DashboardPanel
            key={region.id}
            region={region}
            rowOffset={rowOffset}
          />
        ))}
      </div>
    </section>
  );
}

function StatuslinePanel({
  columns,
  rows,
  statusline,
}: {
  columns: number;
  rows: number;
  statusline: DashboardStatusline;
}) {
  const plugin = pluginRegistry[statusline.pluginId];
  const gridPosition = {
    gridColumn: `1 / span ${columns}`,
    gridRow: statusline.position === 'top' ? '1 / span 1' : `${rows + 1}`,
  };

  if (!plugin) {
    return (
      <PanelFrame title="Statusline" style={gridPosition} variant="statusline">
        <EmptyState
          title="Plugin unavailable"
          detail={`No plugin registered for ${statusline.pluginId}.`}
        />
      </PanelFrame>
    );
  }

  const mergedConfig = { ...plugin.defaultConfig, ...statusline.config };
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame title="Statusline" style={gridPosition} variant="statusline">
      <PluginComponent
        config={mergedConfig}
        region={statuslineRegion(statusline)}
      />
    </PanelFrame>
  );
}

function DashboardPanel({
  region,
  rowOffset,
}: {
  region: DashboardRegion;
  rowOffset: number;
}) {
  const initialTabId = region.defaultTab ?? region.tabs[0]?.id ?? '';
  const [activeTabId, setActiveTabId] = useState(initialTabId);
  const activeTab =
    region.tabs.find((tab) => tab.id === activeTabId) ?? region.tabs[0];
  const gridPosition = {
    gridColumn: `${region.column} / span ${region.columnSpan}`,
    gridRow: `${region.row + rowOffset} / span ${region.rowSpan}`,
  };

  useEffect(() => {
    if (region.tabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(initialTabId);
  }, [activeTabId, initialTabId, region.tabs]);

  if (!activeTab) {
    return (
      <PanelFrame title={region.title} style={gridPosition} variant={region.id}>
        <EmptyState title="Region unavailable" detail="No tabs configured." />
      </PanelFrame>
    );
  }

  const plugin = pluginRegistry[activeTab.pluginId];
  if (!plugin) {
    return (
      <PanelFrame title={region.title} style={gridPosition} variant={region.id}>
        <RegionTabs
          activeTabId={activeTab.id}
          onChange={setActiveTabId}
          tabs={region.tabs}
        />
        <EmptyState
          title="Plugin unavailable"
          detail={`No plugin registered for ${activeTab.pluginId}.`}
        />
      </PanelFrame>
    );
  }

  const mergedConfig = { ...plugin.defaultConfig, ...activeTab.config };
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame title={region.title} style={gridPosition} variant={region.id}>
      <div className="flex h-full min-h-0 flex-col">
        <RegionTabs
          activeTabId={activeTab.id}
          onChange={setActiveTabId}
          tabs={region.tabs}
        />
        <div className="min-h-0 flex-1">
          <PluginComponent
            config={mergedConfig}
            region={tabRegion(region, activeTab)}
          />
        </div>
      </div>
    </PanelFrame>
  );
}

function RegionTabs({
  activeTabId,
  onChange,
  tabs,
}: {
  activeTabId: string;
  onChange: (id: string) => void;
  tabs: DashboardTab[];
}) {
  if (tabs.length <= 1) return null;

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 overflow-hidden border-b border-line bg-field px-2 font-mono text-[10px] tracking-[0.08em]">
      {tabs.map((tab) => (
        <button
          className={
            tab.id === activeTabId
              ? 'shrink-0 border border-primary px-2 py-0.5 text-primary'
              : 'shrink-0 border border-transparent px-2 py-0.5 text-muted hover:border-line hover:text-ink'
          }
          key={tab.id}
          onClick={() => onChange(tab.id)}
          type="button"
        >
          {tab.title}
        </button>
      ))}
    </div>
  );
}

function PanelFrame({
  children,
  style,
  title,
  variant,
}: {
  children: React.ReactNode;
  style: React.CSSProperties;
  title: string;
  variant: string;
}) {
  if (variant === 'statusline') {
    return (
      <Card
        className="panel panel-status min-h-0 overflow-hidden border-x-0 border-t-0"
        style={style}
      >
        {children}
      </Card>
    );
  }

  return (
    <Card
      className={`panel panel-${variant} min-h-0 overflow-hidden border-y-0 border-l-0`}
      style={style}
    >
      <div aria-label={title} className="h-full min-h-0">
        {children}
      </div>
    </Card>
  );
}

export function EmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center">
      <div className="miami-accent h-1 w-12" />
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="max-w-[34ch] text-xs leading-5 text-muted">{detail}</p>
    </div>
  );
}

function BootState({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg text-ink">
      <section className="border border-line bg-panel px-5 py-4">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{detail}</p>
      </section>
    </main>
  );
}

function resolveTheme(theme: DashboardTheme) {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function statuslineRows(config: DashboardConfig) {
  const layoutRows = `repeat(${config.layout.rows}, minmax(0, 1fr))`;
  return config.statusline?.position === 'bottom'
    ? `${layoutRows} 30px`
    : `30px ${layoutRows}`;
}

function statuslineRegion(statusline: DashboardStatusline): DashboardRegion {
  return {
    id: 'statusline',
    title: 'Statusline',
    column: 1,
    row: 1,
    columnSpan: 1,
    rowSpan: 1,
    tabs: [
      {
        id: 'statusline',
        title: 'Statusline',
        pluginId: statusline.pluginId,
        config: statusline.config ?? {},
      },
    ],
  };
}

function tabRegion(
  region: DashboardRegion,
  tab: DashboardTab,
): DashboardRegion {
  return {
    ...region,
    id: `${region.id}:${tab.id}`,
    title: tab.title,
    defaultTab: tab.id,
    tabs: [tab],
  };
}
