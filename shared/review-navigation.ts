import type { NeonReviewFindingSeverity } from './review-finding';

export type ReviewFindingSeverity = NeonReviewFindingSeverity;

export type ReviewNavigationFile = {
  path: string;
  previousPath?: string | null;
};

type ReviewNavigationItemBase = {
  /** Globally stable within its target kind. Hunk ids are file-local instead. */
  id: string;
  path: string;
  summary?: string | null;
  stale?: boolean;
};

export type ReviewHunkNavigationItem = ReviewNavigationItemBase & {
  kind: 'hunk';
  /** Hunk ids need only be unique within `path`; normalized keys include both. */
  id: string;
  oldStart?: number | null;
  newStart?: number | null;
};

export type ReviewThreadNavigationItem = ReviewNavigationItemBase & {
  kind: 'review-thread';
  line?: number | null;
  resolved?: boolean;
};

export type ReviewDraftNavigationItem = ReviewNavigationItemBase & {
  kind: 'local-draft';
  line?: number | null;
};

export type ReviewFindingNavigationItem = ReviewNavigationItemBase & {
  kind: 'finding';
  line?: number | null;
  severity?: ReviewFindingSeverity | null;
};

export type ReviewNavigationItem =
  | ReviewHunkNavigationItem
  | ReviewThreadNavigationItem
  | ReviewDraftNavigationItem
  | ReviewFindingNavigationItem;

export type ReviewNavigationInput = {
  files: readonly ReviewNavigationFile[];
  items?: readonly ReviewNavigationItem[];
  guidedOrder?: readonly string[];
};

export type ReviewNavigationTargetKind = 'file' | ReviewNavigationItem['kind'];

export type ReviewCursorKind = ReviewNavigationTargetKind | 'attention';

export type ReviewNavigationTarget = {
  key: string;
  kind: ReviewNavigationTargetKind;
  id: string;
  path: string;
  requestedPath: string;
  previousPath: string | null;
  /** File position in the order used to produce this target projection. */
  orderIndex: number;
  position: number;
  summary: string | null;
  severity: ReviewFindingSeverity | null;
  stale: boolean;
  missing: boolean;
};

export type ReviewAttentionTarget = Omit<
  ReviewNavigationTarget,
  'key' | 'kind'
> & {
  key: string;
  kind: 'attention';
  attentionKind: 'review-thread' | 'local-draft' | 'finding';
  targetKey: string;
};

export type ReviewCursorTarget = ReviewNavigationTarget | ReviewAttentionTarget;

export type ReviewNavigationModel = {
  canonicalFilePaths: readonly string[];
  guidedFilePaths: readonly string[];
  targets: readonly ReviewNavigationTarget[];
  attentionTargets: readonly ReviewAttentionTarget[];
  unavailableTargets: readonly ReviewNavigationTarget[];
};

export type ReviewNavigationFilter = {
  includeMissing?: boolean;
  includeStale?: boolean;
  kinds?: readonly ReviewCursorKind[];
  paths?: readonly string[];
  query?: string | null;
};

export type ReviewCursorOrder = 'canonical' | 'guided';
export type ReviewCursorDirection = 'previous' | 'next';

export type ReviewCursorResult = {
  target: ReviewCursorTarget | null;
  index: number;
  total: number;
  resolution: 'empty' | 'initial' | 'exact' | 'nearest';
  boundary: 'start' | 'end' | null;
};

const targetKindOrder: Record<ReviewNavigationTargetKind, number> = {
  file: 0,
  hunk: 1,
  'review-thread': 2,
  'local-draft': 3,
  finding: 4,
};

export function createReviewNavigationModel(
  input: ReviewNavigationInput,
): ReviewNavigationModel {
  const files = uniqueFiles(input.files);
  const canonicalFilePaths = files.map((file) => file.path);
  const fileIndexByPath = new Map(
    canonicalFilePaths.map((path, index) => [path, index]),
  );
  const previousPathByPath = new Map(
    files.map((file) => [file.path, file.previousPath ?? null]),
  );
  const aliasToPath = unambiguousPreviousPathAliases(files);
  const guidedFilePaths = normalizeGuidedOrder(
    input.guidedOrder ?? [],
    canonicalFilePaths,
    aliasToPath,
  );
  const seenKeys = new Set<string>();
  const targets: ReviewNavigationTarget[] = canonicalFilePaths.map(
    (path, orderIndex) => ({
      id: path,
      key: targetKey('file', path),
      kind: 'file',
      missing: false,
      orderIndex,
      path,
      position: 0,
      previousPath: previousPathByPath.get(path) ?? null,
      requestedPath: path,
      severity: null,
      stale: false,
      summary: null,
    }),
  );
  for (const target of targets) seenKeys.add(target.key);

  const unavailableTargets: ReviewNavigationTarget[] = [];
  for (const [inputIndex, item] of (input.items ?? []).entries()) {
    if (item.kind === 'review-thread' && item.resolved) continue;
    const resolvedPath = resolvePath(item.path, fileIndexByPath, aliasToPath);
    const missing = resolvedPath === null;
    const path = resolvedPath ?? item.path;
    const key = navigationItemKey(item, path);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const target: ReviewNavigationTarget = {
      orderIndex: resolvedPath
        ? (fileIndexByPath.get(resolvedPath) ?? canonicalFilePaths.length)
        : canonicalFilePaths.length,
      id: item.id,
      key,
      kind: item.kind,
      missing,
      path,
      position: itemPosition(item, inputIndex),
      previousPath: resolvedPath
        ? (previousPathByPath.get(resolvedPath) ?? null)
        : null,
      requestedPath: item.path,
      severity: item.kind === 'finding' ? (item.severity ?? null) : null,
      stale: Boolean(item.stale || missing),
      summary: item.summary?.trim() || null,
    };
    targets.push(target);
    if (missing) unavailableTargets.push(target);
  }

  targets.sort(targetComparator);
  const attentionTargets = targets
    .filter(
      (
        target,
      ): target is ReviewNavigationTarget & {
        kind: 'review-thread' | 'local-draft' | 'finding';
      } =>
        target.kind === 'review-thread' ||
        target.kind === 'local-draft' ||
        target.kind === 'finding',
    )
    .map((target) => ({
      ...target,
      attentionKind: target.kind,
      key: `attention:${target.key}`,
      kind: 'attention' as const,
      targetKey: target.key,
    }));

  return {
    attentionTargets,
    canonicalFilePaths,
    guidedFilePaths,
    targets,
    unavailableTargets,
  };
}

type ReviewCursorTargetOptions = {
  filter?: ReviewNavigationFilter;
  order?: ReviewCursorOrder;
};

export function reviewCursorTargets(
  model: ReviewNavigationModel,
  kind: 'attention',
  options?: ReviewCursorTargetOptions,
): ReviewAttentionTarget[];
export function reviewCursorTargets(
  model: ReviewNavigationModel,
  kind: ReviewNavigationTargetKind,
  options?: ReviewCursorTargetOptions,
): ReviewNavigationTarget[];
export function reviewCursorTargets(
  model: ReviewNavigationModel,
  kind: ReviewCursorKind,
  options: ReviewCursorTargetOptions = {},
): ReviewCursorTarget[] {
  const source =
    kind === 'attention'
      ? model.attentionTargets
      : model.targets.filter((target) => target.kind === kind);
  const order = options.order ?? 'canonical';
  const fileOrder =
    order === 'guided' ? model.guidedFilePaths : model.canonicalFilePaths;
  const fileIndexByPath = new Map(
    fileOrder.map((path, index) => [path, index]),
  );
  const filter = options.filter;
  return source
    .filter((target) => matchesFilter(target, kind, filter))
    .map((target) => ({
      ...target,
      orderIndex: fileIndexByPath.get(target.path) ?? fileOrder.length,
    }))
    .sort(targetComparator);
}

export function moveReviewCursor(
  targets: readonly ReviewCursorTarget[],
  current: string | ReviewCursorTarget | null,
  direction: ReviewCursorDirection,
): ReviewCursorResult {
  if (targets.length === 0) return emptyCursorResult();
  if (current === null) {
    const index = direction === 'next' ? 0 : targets.length - 1;
    return cursorResult(targets, index, 'initial', null);
  }

  const currentKey = typeof current === 'string' ? current : current.key;
  const currentIndex = targets.findIndex((target) => target.key === currentKey);
  if (currentIndex < 0) {
    const nearestIndex = nearestTargetIndex(
      targets,
      typeof current === 'string' ? null : current,
    );
    return cursorResult(targets, nearestIndex, 'nearest', null);
  }

  const nextIndex = currentIndex + (direction === 'next' ? 1 : -1);
  if (nextIndex < 0) {
    return cursorResult(targets, currentIndex, 'exact', 'start');
  }
  if (nextIndex >= targets.length) {
    return cursorResult(targets, currentIndex, 'exact', 'end');
  }
  return cursorResult(targets, nextIndex, 'exact', null);
}

export function reconcileReviewCursor(
  previousTargets: readonly ReviewCursorTarget[],
  nextTargets: readonly ReviewCursorTarget[],
  currentKey: string | null,
): ReviewCursorResult {
  if (nextTargets.length === 0) return emptyCursorResult();
  const exactIndex = currentKey
    ? nextTargets.findIndex((target) => target.key === currentKey)
    : -1;
  if (exactIndex >= 0) {
    return cursorResult(nextTargets, exactIndex, 'exact', null);
  }
  const previousTarget = currentKey
    ? (previousTargets.find((target) => target.key === currentKey) ?? null)
    : null;
  const nearestIndex = nearestTargetIndex(nextTargets, previousTarget);
  return cursorResult(
    nextTargets,
    nearestIndex,
    previousTarget ? 'nearest' : 'initial',
    null,
  );
}

function uniqueFiles(files: readonly ReviewNavigationFile[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const path = file.path.trim();
    if (!path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

function unambiguousPreviousPathAliases(
  files: readonly ReviewNavigationFile[],
) {
  const aliases = new Map<string, string | null>();
  for (const file of files) {
    const previousPath = file.previousPath?.trim();
    if (!previousPath || previousPath === file.path) continue;
    const existing = aliases.get(previousPath);
    aliases.set(
      previousPath,
      existing === undefined || existing === file.path ? file.path : null,
    );
  }
  return new Map(
    [...aliases].filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
}

function normalizeGuidedOrder(
  requestedOrder: readonly string[],
  canonicalOrder: readonly string[],
  aliases: ReadonlyMap<string, string>,
) {
  const canonicalPaths = new Set(canonicalOrder);
  const seen = new Set<string>();
  const guided: string[] = [];
  for (const requestedPath of requestedOrder) {
    const path = canonicalPaths.has(requestedPath)
      ? requestedPath
      : aliases.get(requestedPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    guided.push(path);
  }
  for (const path of canonicalOrder) {
    if (!seen.has(path)) guided.push(path);
  }
  return guided;
}

function resolvePath(
  path: string,
  fileIndexByPath: ReadonlyMap<string, number>,
  aliases: ReadonlyMap<string, string>,
) {
  if (fileIndexByPath.has(path)) return path;
  return aliases.get(path) ?? null;
}

function itemPosition(item: ReviewNavigationItem, inputIndex: number) {
  const line =
    item.kind === 'hunk'
      ? (positiveNumber(item.newStart) ?? positiveNumber(item.oldStart))
      : positiveNumber(item.line);
  return line ?? 1_000_000_000 + inputIndex;
}

function positiveNumber(value: number | null | undefined) {
  return typeof value === 'number' && value >= 0 ? value : null;
}

function targetKey(kind: ReviewNavigationTargetKind, id: string) {
  return `${kind}:${id}`;
}

function navigationItemKey(item: ReviewNavigationItem, resolvedPath: string) {
  if (item.kind === 'hunk') {
    return `hunk:${JSON.stringify([resolvedPath, item.id])}`;
  }
  return targetKey(item.kind, item.id);
}

function targetComparator(left: ReviewCursorTarget, right: ReviewCursorTarget) {
  return (
    left.orderIndex - right.orderIndex ||
    left.position - right.position ||
    cursorKindOrder(left) - cursorKindOrder(right) ||
    left.key.localeCompare(right.key)
  );
}

function cursorKindOrder(target: ReviewCursorTarget) {
  return target.kind === 'attention'
    ? targetKindOrder[target.attentionKind]
    : targetKindOrder[target.kind];
}

function matchesFilter(
  target: ReviewCursorTarget,
  kind: ReviewCursorKind,
  filter: ReviewNavigationFilter | undefined,
) {
  if (!filter) return !target.missing;
  if (!filter.includeMissing && target.missing) return false;
  if (filter.includeStale === false && target.stale) return false;
  const targetKind =
    target.kind === 'attention' ? target.attentionKind : target.kind;
  if (
    filter.kinds &&
    !filter.kinds.includes(kind) &&
    !filter.kinds.includes(targetKind)
  ) {
    return false;
  }
  if (
    filter.paths &&
    !filter.paths.some((path) => targetMatchesPath(target, path))
  ) {
    return false;
  }
  const query = filter.query?.trim().toLocaleLowerCase();
  if (!query) return true;
  return [
    target.id,
    target.path,
    target.previousPath,
    target.requestedPath,
    target.summary,
    target.severity,
    target.kind === 'attention' ? target.attentionKind : target.kind,
  ].some((value) => value?.toLocaleLowerCase().includes(query));
}

function targetMatchesPath(target: ReviewCursorTarget, path: string) {
  return (
    target.path === path ||
    target.previousPath === path ||
    target.requestedPath === path
  );
}

function nearestTargetIndex(
  targets: readonly ReviewCursorTarget[],
  anchor: ReviewCursorTarget | null,
) {
  if (!anchor) return 0;
  let bestIndex = 0;
  let bestScore: readonly number[] | null = null;
  for (const [index, target] of targets.entries()) {
    const sameFile = targetMatchesPath(target, anchor.path) ? 0 : 1;
    const fileDistance = Math.abs(target.orderIndex - anchor.orderIndex);
    const preferFollowingFile = target.orderIndex >= anchor.orderIndex ? 0 : 1;
    const positionDistance = Math.abs(target.position - anchor.position);
    const preferFollowingPosition = target.position >= anchor.position ? 0 : 1;
    const score = [
      sameFile,
      fileDistance,
      preferFollowingFile,
      positionDistance,
      preferFollowingPosition,
      index,
    ] as const;
    if (!bestScore || compareScore(score, bestScore) < 0) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestIndex;
}

function compareScore(left: readonly number[], right: readonly number[]) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function emptyCursorResult(): ReviewCursorResult {
  return {
    boundary: null,
    index: -1,
    resolution: 'empty',
    target: null,
    total: 0,
  };
}

function cursorResult(
  targets: readonly ReviewCursorTarget[],
  index: number,
  resolution: Exclude<ReviewCursorResult['resolution'], 'empty'>,
  boundary: ReviewCursorResult['boundary'],
): ReviewCursorResult {
  return {
    boundary,
    index,
    resolution,
    target: targets[index] ?? null,
    total: targets.length,
  };
}
