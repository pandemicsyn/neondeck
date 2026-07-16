import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import {
  getDashboardConfig,
  openChatSessionCommandEventStream,
  openChatSessionEventStream,
  openConfigEventStream,
} from './api';
import { BootState, Card, EmptyState } from './components/ui';
import {
  configEventTouchesFile,
  dispatchConfigChangeEvent,
} from './lib/config-events';
import type { DeckArrangement } from './lib/deck-profile';
import { useDeckProfile } from './lib/deck-profile';
import { queryErrorMessage, queryKeys } from './lib/query';
import { pluginRegistry, resolvePluginConfig } from './plugins/registry';
import type {
  ReviewPopoutAppearance,
  ReviewPopoutTarget,
} from './features/pr-review/PrReviewPopoutPage';
import { NotificationController } from './features/notifications/controller';
import type {
  DashboardConfig,
  DashboardDensity,
  DashboardRegion,
  DashboardStatusline,
  DashboardTab,
  DashboardTheme,
} from './types';

const loadPrReviewPopout = () =>
  import('./features/pr-review/PrReviewPopoutPage');
const PrReviewPopoutPage = lazy(() =>
  loadPrReviewPopout().then((module) => ({
    default: module.PrReviewPopoutPage,
  })),
);
const PrReviewPopoutErrorPage = lazy(() =>
  loadPrReviewPopout().then((module) => ({
    default: module.PrReviewPopoutErrorPage,
  })),
);

const defaultReviewAppearance: ReviewPopoutAppearance = {
  density: 'comfortable',
  textScale: 1.12,
};

if (typeof window !== 'undefined' && window.location.pathname === '/review') {
  void loadPrReviewPopout();
}

export function App() {
  const queryClient = useQueryClient();
  const reviewRoute = useMemo(readReviewPopoutRoute, []);
  const isDashboardRoute = reviewRoute.kind === 'none';
  const {
    data: config,
    error,
    isLoading,
  } = useQuery({
    queryKey: queryKeys.dashboardConfig,
    queryFn: getDashboardConfig,
    enabled: isDashboardRoute,
  });

  useEffect(() => {
    if (!isDashboardRoute) return;
    return openConfigEventStream(
      (event) => {
        dispatchConfigChangeEvent(event);
        if (
          event.action === 'config_reload' ||
          configEventTouchesFile(event, 'dashboard.json')
        ) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.dashboardConfig,
          });
        }
      },
      undefined,
      () => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.dashboardConfig,
        });
      },
    );
  }, [isDashboardRoute, queryClient]);

  useEffect(() => {
    if (!isDashboardRoute) return;
    const refreshSessions = () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.neonSession,
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatSessions,
      });
    };
    const closeSessionEvents = openChatSessionEventStream(
      refreshSessions,
      undefined,
      refreshSessions,
    );
    const closeCommandEvents =
      openChatSessionCommandEventStream(refreshSessions);
    return () => {
      closeCommandEvents();
      closeSessionEvents();
    };
  }, [isDashboardRoute, queryClient]);

  useEffect(() => {
    if (!config) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.theme = resolveTheme(config.theme);
    };
    applyTheme();
    if (config.theme !== 'system') return;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [config]);

  const reviewAppearance = config
    ? resolveAppearance(config)
    : defaultReviewAppearance;

  if (reviewRoute.kind === 'target') {
    return (
      <main className="deck-page h-screen overflow-hidden bg-bg text-ink">
        <Suspense
          fallback={<ReviewPopoutLoadingPage appearance={reviewAppearance} />}
        >
          <PrReviewPopoutPage
            appearance={reviewAppearance}
            target={reviewRoute.target}
          />
        </Suspense>
      </main>
    );
  }

  if (reviewRoute.kind === 'invalid') {
    return (
      <main className="deck-page h-screen overflow-hidden bg-bg text-ink">
        <Suspense
          fallback={<ReviewPopoutLoadingPage appearance={reviewAppearance} />}
        >
          <PrReviewPopoutErrorPage
            appearance={reviewAppearance}
            detail={reviewRoute.message}
            title="Invalid review route"
          />
        </Suspense>
      </main>
    );
  }

  if (error) {
    return (
      <BootState
        title="Dashboard config failed"
        detail={queryErrorMessage(error)}
        tone="alert"
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
      <NotificationController config={config}>
        <DashboardShell config={config} />
      </NotificationController>
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
      aria-labelledby="neondeck-dashboard-title"
      ref={shellRef}
      className="deck-shell h-screen w-screen overflow-hidden bg-bg p-0"
    >
      <h1 className="sr-only" id="neondeck-dashboard-title">
        Neondeck developer cockpit
      </h1>
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
          tone="alert"
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
  const [focusPulse, setFocusPulse] = useState(false);
  const tabIdPrefix = useId();
  const defaultTabRef = useRef({ regionId: region.id, tabId: initialTabId });
  const activeTab =
    region.tabs.find((tab) => tab.id === activeTabId) ?? region.tabs[0];
  const tabPanelId = `${tabIdPrefix}-panel`;
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

  useEffect(() => {
    function handleNavigation(event: Event) {
      const detail = (
        event as CustomEvent<{ pluginId?: string; handled?: boolean }>
      ).detail;
      const targetPluginId = detail?.pluginId ?? 'flue-chat';
      const tab = region.tabs.find(
        (entry) => entry.pluginId === targetPluginId,
      );
      if (!tab) return;
      detail.handled = true;
      setActiveTabId(tab.id);
      setFocusPulse(true);
      window.setTimeout(() => setFocusPulse(false), 900);
    }

    window.addEventListener('neondeck:navigate', handleNavigation);
    window.addEventListener('neondeck:focus-chat', handleNavigation);
    return () => {
      window.removeEventListener('neondeck:navigate', handleNavigation);
      window.removeEventListener('neondeck:focus-chat', handleNavigation);
    };
  }, [region.tabs]);

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
        <EmptyState
          title="Region unavailable"
          detail="No tabs configured."
          tone="alert"
        />
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
          panelId={tabPanelId}
          regionId={region.id}
          tabIdPrefix={tabIdPrefix}
          tabs={region.tabs}
        />
        <div
          aria-label={region.tabs.length <= 1 ? activeTab.title : undefined}
          aria-labelledby={
            region.tabs.length > 1
              ? dashboardTabId(
                  tabIdPrefix,
                  region.tabs.findIndex((tab) => tab.id === activeTab.id),
                )
              : undefined
          }
          className="min-h-0 flex-1"
          id={tabPanelId}
          role="tabpanel"
        >
          <EmptyState
            title="Plugin unavailable"
            detail={`No plugin registered for ${activeTab.pluginId}.`}
            tone="alert"
          />
        </div>
      </PanelFrame>
    );
  }

  const resolvedConfig = resolvePluginConfig(plugin, activeTab.config);
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame
      regionRole={role}
      highlight={focusPulse}
      style={style}
      title={region.title}
      variant={region.id}
    >
      <div className="flex h-full min-h-0 flex-col">
        <RegionTabs
          activeTabId={activeTab.id}
          onChange={setActiveTabId}
          panelId={tabPanelId}
          regionId={region.id}
          tabIdPrefix={tabIdPrefix}
          tabs={region.tabs}
        />
        <ConfigIssues issues={resolvedConfig.issues} />
        <div
          aria-label={region.tabs.length <= 1 ? activeTab.title : undefined}
          aria-labelledby={
            region.tabs.length > 1
              ? dashboardTabId(
                  tabIdPrefix,
                  region.tabs.findIndex((tab) => tab.id === activeTab.id),
                )
              : undefined
          }
          className="min-h-0 flex-1"
          id={tabPanelId}
          role="tabpanel"
          tabIndex={0}
        >
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
    <div
      className="border-b border-accent bg-field px-2 py-1 font-mono text-[10px] leading-4 text-accent"
      role="alert"
    >
      Invalid panel config ignored: {issues.join(' ')}
    </div>
  );
}

function RegionTabs({
  activeTabId,
  onChange,
  panelId,
  regionId,
  tabIdPrefix,
  tabs,
}: {
  activeTabId: string;
  onChange: (id: string) => void;
  panelId: string;
  regionId: string;
  tabIdPrefix: string;
  tabs: DashboardTab[];
}) {
  if (tabs.length <= 1) return null;

  return (
    <div
      aria-label={`${regionId} views`}
      className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-field px-2 font-mono text-[10px] tracking-[0.08em]"
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <button
          aria-controls={panelId}
          aria-selected={tab.id === activeTabId}
          className={
            tab.id === activeTabId
              ? 'shrink-0 border border-primary px-2 py-0.5 text-primary'
              : 'shrink-0 border border-transparent px-2 py-0.5 text-muted hover:border-line hover:text-ink'
          }
          id={dashboardTabId(tabIdPrefix, index)}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            let nextIndex: number | undefined;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              nextIndex = (index + 1) % tabs.length;
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              nextIndex = (index - 1 + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
              nextIndex = 0;
            } else if (event.key === 'End') {
              nextIndex = tabs.length - 1;
            }
            if (nextIndex === undefined) return;
            event.preventDefault();
            const nextTab = tabs[nextIndex];
            if (!nextTab) return;
            onChange(nextTab.id);
            document
              .getElementById(dashboardTabId(tabIdPrefix, nextIndex))
              ?.focus();
          }}
          role="tab"
          tabIndex={tab.id === activeTabId ? 0 : -1}
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
  highlight = false,
  regionRole,
  style,
  title,
  variant,
}: {
  children: React.ReactNode;
  highlight?: boolean;
  regionRole: RegionRole;
  style: React.CSSProperties;
  title: string;
  variant: string;
}) {
  const headingId = `${useId()}-heading`;
  if (variant === 'statusline') {
    return (
      <Card
        className={`panel panel-status min-h-0 overflow-hidden border-x-0 border-t-0 ${
          highlight ? 'ring-1 ring-primary' : ''
        }`}
        data-region-role={regionRole}
        style={style}
      >
        <section aria-labelledby={headingId} className="h-full min-h-0">
          <h2 className="sr-only" id={headingId}>
            {title}
          </h2>
          {children}
        </section>
      </Card>
    );
  }

  return (
    <Card
      className={`panel panel-${variant} min-h-0 overflow-hidden border-y-0 border-l-0 ${
        highlight ? 'ring-1 ring-primary' : ''
      }`}
      data-region-role={regionRole}
      style={style}
    >
      <section aria-labelledby={headingId} className="h-full min-h-0">
        <h2 className="sr-only" id={headingId}>
          {title}
        </h2>
        {children}
      </section>
    </Card>
  );
}

function dashboardTabId(tabIdPrefix: string, index: number) {
  return `${tabIdPrefix}-tab-${index}`;
}

function resolveTheme(theme: DashboardTheme) {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

type ReviewPopoutRoute =
  | { kind: 'none' }
  | { kind: 'invalid'; message: string }
  | { kind: 'target'; target: ReviewPopoutTarget };

function ReviewPopoutLoadingPage({
  appearance,
}: {
  appearance: ReviewPopoutAppearance;
}) {
  const style = {
    '--deck-text-scale': appearance.textScale.toString(),
  } as CSSProperties;
  return (
    <section
      className={`dashboard-grid deck-density-${appearance.density} pr-review-popout-page`}
      data-deck-arrangement="review-popout"
      data-deck-profile="review-popout"
      data-display-preset="review-popout"
      style={style}
    >
      <output
        aria-label="Loading PR review workbench"
        aria-live="polite"
        className="pr-review-popout-skeleton"
      >
        <div className="pr-review-popout-skeleton-header">
          <span className="pr-review-popout-skeleton-line pr-review-popout-skeleton-title" />
          <span className="pr-review-popout-skeleton-line pr-review-popout-skeleton-badges" />
        </div>
        <div className="pr-review-popout-skeleton-workbench">
          <span className="pr-review-popout-skeleton-pane" />
          <span className="pr-review-popout-skeleton-pane" />
          <span className="pr-review-popout-skeleton-pane" />
        </div>
        <div className="pr-review-popout-skeleton-footer" />
        <span className="sr-only">Loading the review workbench.</span>
      </output>
    </section>
  );
}

function readReviewPopoutRoute(): ReviewPopoutRoute {
  if (window.location.pathname !== '/review') return { kind: 'none' };
  const params = new URLSearchParams(window.location.search);
  const repo = params.get('repo')?.trim();
  const number = Number(params.get('number'));
  if (!repo) {
    return {
      kind: 'invalid',
      message:
        'A repository query parameter is required, for example /review?repo=owner/repo&number=123.',
    };
  }
  const repoParts = repo.split('/');
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    return {
      kind: 'invalid',
      message:
        'The repository query parameter must be in owner/repo form, for example /review?repo=owner/repo&number=123.',
    };
  }
  if (!Number.isInteger(number) || number < 1) {
    return {
      kind: 'invalid',
      message:
        'A positive pull request number is required, for example /review?repo=owner/repo&number=123.',
    };
  }
  return {
    kind: 'target',
    target: {
      repo,
      number,
      headSha: params.get('head')?.trim() || null,
      baseSha: params.get('base')?.trim() || null,
      baseRef: params.get('baseRef')?.trim() || null,
      title: params.get('title')?.trim() || null,
    },
  };
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
