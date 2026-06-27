import { useEffect, useMemo, useState } from 'react';
import { getDashboardConfig } from './api';
import { Card } from './components/ui';
import { pluginRegistry } from './plugins/registry';
import type { DashboardConfig, DashboardRegion, DashboardTheme } from './types';

export function App() {
  const [config, setConfig] = useState<DashboardConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    getDashboardConfig()
      .then(setConfig)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    if (!config) return;
    const resolved = resolveTheme(config.theme);
    document.documentElement.dataset.theme = resolved;
  }, [config]);

  if (error) {
    return <BootState title="Dashboard config failed" detail={error} />;
  }

  if (!config) {
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
      gridTemplateRows:
        config.layout.rows === 6
          ? '30px repeat(5, minmax(0, 1fr))'
          : `repeat(${config.layout.rows}, minmax(0, 1fr))`,
    }),
    [config],
  );

  return (
    <section className="deck-shell h-screen w-screen overflow-hidden bg-bg p-0">
      <div
        className="dashboard-grid grid h-full w-full gap-0 border-0 bg-canvas p-0"
        style={gridStyle}
      >
        {config.layout.regions.map((region) => (
          <DashboardPanel key={region.id} region={region} />
        ))}
      </div>
    </section>
  );
}

function DashboardPanel({ region }: { region: DashboardRegion }) {
  const plugin = pluginRegistry[region.pluginId];
  const gridPosition = {
    gridColumn: `${region.column} / span ${region.columnSpan}`,
    gridRow: `${region.row} / span ${region.rowSpan}`,
  };

  if (!plugin) {
    return (
      <PanelFrame title={region.title} style={gridPosition} variant={region.id}>
        <EmptyState
          title="Plugin unavailable"
          detail={`No plugin registered for ${region.pluginId}.`}
        />
      </PanelFrame>
    );
  }

  const mergedConfig = { ...plugin.defaultConfig, ...region.config };
  const PluginComponent = plugin.Component;

  return (
    <PanelFrame title={region.title} style={gridPosition} variant={region.id}>
      <PluginComponent region={region} config={mergedConfig} />
    </PanelFrame>
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
