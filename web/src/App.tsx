import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  getDashboardConfig,
  openChatSessionEventStream,
  openConfigEventStream,
} from './api';
import { Card } from './components/ui';
import {
  configEventTouchesFile,
  dispatchConfigChangeEvent,
} from './lib/config-events';
import type { DeckArrangement } from './lib/deck-profile';
import { useDeckProfile } from './lib/deck-profile';
import { queryErrorMessage, queryKeys } from './lib/query';
import { pluginRegistry, resolvePluginConfig } from './plugins/registry';
import type {
  DashboardConfig,
  DashboardDensity,
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
    return openChatSessionEventStream(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.neonSession,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatSessions,
      });
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
  const appearance = resolveAppearance(config);
  const layoutMode = config.layout.mode ?? 'auto';
  const { ref: shellRef, profile, arrangement } = useDeckProfile(layoutMode);
  const gridStyle = useMemo(() => {
    const style: CSSProperties = {
      '--deck-text-scale': appearance.textScale.toString(),
    } as CSSProperties;
    if (arrangement === 'grid') {
      style.gridTemplateColumns = `repeat(${config.layout.columns}, minmax(0, 1fr))`;
      style.gridTemplateRows = config.statusline
        ? statuslineRows(config)
        : `repeat(${config.layout.rows}, minmax(0, 1fr))`;
    }
    return style;
  }, [appearance.textScale, config, arrangement]);
  const rowOffset = config.statusline?.position === 'top' ? 1 : 0;
  const displayPreset = resolveDisplayPreset(config);

  return (
    <section
      ref={shellRef}
      className="deck-shell h-screen w-screen overflow-hidden bg-bg p-0"
    >
      <div
        className={`dashboard-grid deck-density-${appearance.density} grid h-full w-full gap-0 border-0 bg-canvas p-0`}
        data-display-preset={displayPreset}
        data-deck-profile={profile}
        data-deck-arrangement={arrangement}
        style={gridStyle}
      >
        {/*
         * In the column arrangement, DOM order is what drives visual order
         * (we don't use CSS `order` for the statusline), so render it before
         * or after the regions based on its configured edge. That also keeps
         * keyboard tab order aligned with the visual reading order.
         */}
        {config.statusline && config.statusline.position !== 'bottom' ? (
          <StatuslinePanel
            arrangement={arrangement}
            columns={config.layout.columns}
            rows={config.layout.rows}
            statusline={config.statusline}
          />
        ) : null}
        {config.layout.regions.map((region) => (
          <DashboardPanel
            key={region.id}
            arrangement={arrangement}
            region={region}
            rowOffset={rowOffset}
          />
        ))}
        {config.statusline && config.statusline.position === 'bottom' ? (
          <StatuslinePanel
            arrangement={arrangement}
            columns={config.layout.columns}
            rows={config.layout.rows}
            statusline={config.statusline}
          />
        ) : null}
      </div>
    </section>
  );
}

type RegionRole = 'agent' | 'data' | 'status';

function regionPrimaryRole(region: DashboardRegion): RegionRole {
  const tabId = region.defaultTab ?? region.tabs[0]?.id;
  const tab = region.tabs.find((entry) => entry.id === tabId) ?? region.tabs[0];
  const plugin = tab ? pluginRegistry[tab.pluginId] : undefined;
  return plugin?.kind ?? 'data';
}

// In the vertical column arrangement, role drives stacking order for the
// regions: the data rail sits as a compact band above the agent surface
// (chat), which grows to fill the remaining height. The statusline pins to
// its edge via DOM order (see DashboardShell), not via CSS `order`, so that
// keyboard tab order matches the visual reading order.
function columnOrder(role: RegionRole) {
  if (role === 'data') return 10;
  return 20;
}

function StatuslinePanel({
  arrangement,
  columns,
  rows,
  statusline,
}: {
  arrangement: DeckArrangement;
  columns: number;
  rows: number;
  statusline: DashboardStatusline;
}) {
  const plugin = pluginRegistry[statusline.pluginId];
  const style: CSSProperties =
    arrangement === 'grid'
      ? {
          gridColumn: `1 / span ${columns}`,
          gridRow: statusline.position === 'top' ? '1 / span 1' : `${rows + 1}`,
        }
      : // Column arrangement uses DOM order, not CSS `order`, to position the
        // statusline (see DashboardShell), so no inline style is needed here.
        {};

  if (!plugin) {
    return (
      <PanelFrame
        regionRole="status"
        style={style}
        title="Statusline"
        variant="statusline"
      >
        <EmptyState
          title="Plugin unavailable"
          detail={`No plugin registered for ${statusline.pluginId}.`}
        />
      </PanelFrame>
    );
  }

  const resolvedConfig = resolvePluginConfig(plugin, statusline.config);
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame
      regionRole="status"
      style={style}
      title="Statusline"
      variant="statusline"
    >
      <ConfigIssues issues={resolvedConfig.issues} />
      <PluginComponent
        config={resolvedConfig.config}
        region={statuslineRegion(statusline)}
      />
    </PanelFrame>
  );
}

function DashboardPanel({
  arrangement,
  region,
  rowOffset,
}: {
  arrangement: DeckArrangement;
  region: DashboardRegion;
  rowOffset: number;
}) {
  const initialTabId = region.defaultTab ?? region.tabs[0]?.id ?? '';
  const [activeTabId, setActiveTabId] = useState(initialTabId);
  const defaultTabRef = useRef({ regionId: region.id, tabId: initialTabId });
  const activeTab =
    region.tabs.find((tab) => tab.id === activeTabId) ?? region.tabs[0];
  const role = regionPrimaryRole(region);
  const style: CSSProperties =
    arrangement === 'grid'
      ? {
          gridColumn: `${region.column} / span ${region.columnSpan}`,
          gridRow: `${region.row + rowOffset} / span ${region.rowSpan}`,
        }
      : { order: columnOrder(role) };

  useEffect(() => {
    const defaultChanged =
      defaultTabRef.current.regionId !== region.id ||
      defaultTabRef.current.tabId !== initialTabId;
    defaultTabRef.current = { regionId: region.id, tabId: initialTabId };
    if (defaultChanged) {
      setActiveTabId(initialTabId);
      return;
    }

    if (region.tabs.some((tab) => tab.id === activeTabId)) return;
    setActiveTabId(initialTabId);
  }, [activeTabId, initialTabId, region.id, region.tabs]);

  // In column mode an error frame must stay visible, not be capped under the
  // data band's max-height. Promote the failing region to the agent role so it
  // uses the floor + grow behavior and the misconfiguration is unmissable.
  const errorRole: RegionRole = 'agent';
  const errorStyle: CSSProperties =
    arrangement === 'grid' ? style : { order: columnOrder(errorRole) };

  if (!activeTab) {
    return (
      <PanelFrame
        regionRole={errorRole}
        style={errorStyle}
        title={region.title}
        variant={region.id}
      >
        <EmptyState title="Region unavailable" detail="No tabs configured." />
      </PanelFrame>
    );
  }

  const plugin = pluginRegistry[activeTab.pluginId];
  if (!plugin) {
    return (
      <PanelFrame
        regionRole={errorRole}
        style={errorStyle}
        title={region.title}
        variant={region.id}
      >
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

  const resolvedConfig = resolvePluginConfig(plugin, activeTab.config);
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame
      regionRole={role}
      style={style}
      title={region.title}
      variant={region.id}
    >
      <div className="flex h-full min-h-0 flex-col">
        <RegionTabs
          activeTabId={activeTab.id}
          onChange={setActiveTabId}
          tabs={region.tabs}
        />
        <ConfigIssues issues={resolvedConfig.issues} />
        <div className="min-h-0 flex-1">
          <PluginComponent
            config={resolvedConfig.config}
            region={tabRegion(region, activeTab)}
          />
        </div>
      </div>
    </PanelFrame>
  );
}

function ConfigIssues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;

  return (
    <div className="border-b border-accent bg-field px-2 py-1 font-mono text-[10px] leading-4 text-accent">
      Invalid panel config ignored: {issues.join(' ')}
    </div>
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
  regionRole,
  style,
  title,
  variant,
}: {
  children: React.ReactNode;
  regionRole: RegionRole;
  style: React.CSSProperties;
  title: string;
  variant: string;
}) {
  if (variant === 'statusline') {
    return (
      <Card
        className="panel panel-status min-h-0 overflow-hidden border-x-0 border-t-0"
        data-region-role={regionRole}
        style={style}
      >
        {children}
      </Card>
    );
  }

  return (
    <Card
      className={`panel panel-${variant} min-h-0 overflow-hidden border-y-0 border-l-0`}
      data-region-role={regionRole}
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

function resolveAppearance(config: DashboardConfig): {
  density: DashboardDensity;
  textScale: number;
} {
  const density = config.appearance?.density ?? 'comfortable';
  const densityScale: Record<DashboardDensity, number> = {
    compact: 1,
    comfortable: 1.12,
    large: 1.24,
  };
  return {
    density,
    textScale: config.appearance?.textScale ?? densityScale[density],
  };
}

function resolveDisplayPreset(config: DashboardConfig) {
  if (config.display.preset) return config.display.preset;
  if (config.display.width === 2560 && config.display.height === 720) {
    return 'xeneon-edge';
  }
  return 'custom';
}

function statuslineRows(config: DashboardConfig) {
  const layoutRows = `repeat(${config.layout.rows}, minmax(0, 1fr))`;
  const statuslineHeight = 'var(--deck-statusline-height)';
  return config.statusline?.position === 'bottom'
    ? `${layoutRows} ${statuslineHeight}`
    : `${statuslineHeight} ${layoutRows}`;
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
