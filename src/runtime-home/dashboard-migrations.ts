import {
  isRecord,
  readJsonObjectLenient,
  readJsonObjectLenientSync,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from './files.ts';

export const dashboardSchemaVersion = 1;

const reviewsTab = {
  id: 'reviews',
  title: 'REVIEWS',
  pluginId: 'reviews-panel',
  config: {},
};

export async function migrateDashboardConfig(path: string) {
  const current = await readJsonObjectLenient(path);
  const migrated = migrateDashboardConfigValue(current);
  if (migrated) await writeJsonAtomic(path, migrated);
}

export function migrateDashboardConfigSync(path: string) {
  const current = readJsonObjectLenientSync(path);
  const migrated = migrateDashboardConfigValue(current);
  if (migrated) writeJsonAtomicSync(path, migrated);
}

export function migrateDashboardConfigValue(
  current: Record<string, unknown> | null,
) {
  if (!current) return null;
  const version =
    typeof current.schemaVersion === 'number' &&
    Number.isInteger(current.schemaVersion)
      ? current.schemaVersion
      : 0;
  if (version >= dashboardSchemaVersion) return null;

  const layout = isRecord(current.layout) ? current.layout : null;
  const regions = Array.isArray(layout?.regions) ? layout.regions : null;
  const hasReviews = regions?.some(
    (region) =>
      isRecord(region) &&
      Array.isArray(region.tabs) &&
      region.tabs.some(
        (tab) =>
          isRecord(tab) &&
          (tab.id === reviewsTab.id || tab.pluginId === reviewsTab.pluginId),
      ),
  );
  const workRegionIndex = regions?.findIndex(
    (region) =>
      isRecord(region) &&
      (region.id === 'work' ||
        (Array.isArray(region.tabs) &&
          region.tabs.some(
            (tab) => isRecord(tab) && tab.pluginId === 'github-pr-list',
          ))),
  );
  const fallbackRegionIndex = regions?.findIndex(
    (region) => isRecord(region) && Array.isArray(region.tabs),
  );
  const targetRegionIndex =
    workRegionIndex !== undefined && workRegionIndex >= 0
      ? workRegionIndex
      : fallbackRegionIndex;

  let nextLayout = layout;
  if (
    !hasReviews &&
    regions &&
    targetRegionIndex !== undefined &&
    targetRegionIndex >= 0
  ) {
    const targetRegion = regions[targetRegionIndex];
    if (isRecord(targetRegion) && Array.isArray(targetRegion.tabs)) {
      const tabs = [...targetRegion.tabs];
      const githubIndex = tabs.findIndex(
        (tab) => isRecord(tab) && tab.pluginId === 'github-pr-list',
      );
      const insertIndex =
        workRegionIndex !== undefined && workRegionIndex >= 0
          ? githubIndex >= 0
            ? githubIndex + 1
            : 0
          : tabs.length;
      tabs.splice(insertIndex, 0, reviewsTab);
      const nextRegions = [...regions];
      nextRegions[targetRegionIndex] = { ...targetRegion, tabs };
      nextLayout = { ...layout, regions: nextRegions };
    }
  }

  return {
    ...current,
    schemaVersion: dashboardSchemaVersion,
    ...(nextLayout ? { layout: nextLayout } : {}),
  };
}
