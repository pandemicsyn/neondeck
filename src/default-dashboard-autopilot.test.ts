import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDashboardConfig } from './runtime-home';

describe('checked-in dashboard Autopilot surface', () => {
  it('uses Active Watches without the legacy Autopilot panel', () => {
    const dashboardPath = new URL('../config/dashboard.json', import.meta.url);
    const dashboard = parseDashboardConfig(
      JSON.parse(readFileSync(dashboardPath, 'utf8')),
      dashboardPath.pathname,
    );
    const pluginIds = dashboard.layout.regions.flatMap((region) =>
      region.tabs.map((tab) => tab.pluginId),
    );

    expect(pluginIds).toContain('active-watches');
    expect(pluginIds).not.toContain('autopilot');
  });
});
