import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  prepareFileTreeInput,
  type FileTreeInitialExpansion,
  type FileTreePreparedInput,
  type GitStatusEntry,
} from '@pierre/trees';
import { diffStatsLabel } from './helpers';
import type { DiffFilePatch, FileReviewMapEntry } from './types';

const expandedTreeFileLimit = 120;

type FileTreePaneProps = {
  files: DiffFilePatch[];
  filterQuery?: string | null;
  onFilterChange?: (query: string | null, paths: string[] | null) => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  reviewMapByPath?: ReadonlyMap<string, FileReviewMapEntry>;
};

export function FileTreePane({
  files,
  filterQuery,
  onFilterChange,
  selectedPath,
  onSelectPath,
  reviewMapByPath,
}: FileTreePaneProps) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const gitStatus = useMemo(
    () =>
      files
        .map((file) => gitStatusEntry(file))
        .filter((entry): entry is GitStatusEntry => Boolean(entry)),
    [files],
  );
  const preparedInput = useMemo(() => prepareFileTreeInput(paths), [paths]);
  const initialExpansion: FileTreeInitialExpansion =
    paths.length > expandedTreeFileLimit ? 'closed' : 'open';
  const treeKey = useMemo(() => fileTreeModelKey(paths), [paths]);

  if (paths.length === 0) return null;

  return (
    <FileTreePaneModel
      files={files}
      filterQuery={filterQuery}
      gitStatus={gitStatus}
      initialExpansion={initialExpansion}
      key={treeKey}
      onSelectPath={onSelectPath}
      onFilterChange={onFilterChange}
      paths={paths}
      preparedInput={preparedInput}
      reviewMapByPath={reviewMapByPath}
      selectedPath={selectedPath}
    />
  );
}

function FileTreePaneModel({
  files,
  filterQuery,
  gitStatus,
  initialExpansion,
  onSelectPath,
  onFilterChange,
  paths,
  preparedInput,
  reviewMapByPath,
  selectedPath,
}: FileTreePaneProps & {
  gitStatus: GitStatusEntry[];
  initialExpansion: FileTreeInitialExpansion;
  paths: string[];
  preparedInput: FileTreePreparedInput;
}) {
  const reviewMapRef = useRef(reviewMapByPath);
  reviewMapRef.current = reviewMapByPath;
  const previousPathAliasRef = useRef<ReadonlyMap<string, string>>(new Map());
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const occupiedPathSet = useMemo(() => occupiedFileTreePaths(paths), [paths]);
  const [searchQuery, setSearchQuery] = useState(filterQuery?.trim() ?? '');
  const filterId = useId();
  const filterProjection = useMemo(
    () =>
      fileTreeFilterProjection(
        files,
        searchQuery,
        reviewMapByPath,
        occupiedPathSet,
      ),
    [files, occupiedPathSet, reviewMapByPath, searchQuery],
  );
  const filterProjectionKey = useMemo(
    () => fileTreeModelKey(filterProjection.treePaths),
    [filterProjection.treePaths],
  );
  const filterTreePathsRef = useRef(filterProjection.treePaths);
  filterTreePathsRef.current = filterProjection.treePaths;
  previousPathAliasRef.current = filterProjection.previousPathAliases;
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus,
    initialExpansion,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 24,
    onSelectionChange(selectedPaths) {
      const nextPath = [...selectedPaths]
        .reverse()
        .map((path) => previousPathAliasRef.current.get(path) ?? path)
        .find((path) => filePathSet.has(path));
      if (nextPath) onSelectPath(nextPath);
    },
    preparedInput,
    renderRowDecoration({ item }) {
      if (item.kind !== 'file') return null;
      const currentPath =
        previousPathAliasRef.current.get(item.path) ?? item.path;
      if (currentPath !== item.path) {
        return {
          text: `renamed → ${currentPath}`,
          title: `${item.path} was renamed to ${currentPath}.`,
        };
      }
      const entry = reviewMapRef.current?.get(currentPath);
      return entry && fileReviewMapHasStatus(entry)
        ? {
            text: fileReviewMapDecoration(entry),
            title: fileReviewMapStatusLabel(entry),
          }
        : null;
    },
    unsafeCSS: treeUnsafeCss,
  });

  useEffect(() => {
    model.resetPaths({
      preparedInput: prepareFileTreeInput(filterTreePathsRef.current),
    });
  }, [filterProjectionKey, model]);

  useEffect(() => {
    if (filterQuery === undefined) return;
    const next = filterQuery?.trim() ?? '';
    setSearchQuery((current) => (current === next ? current : next));
  }, [filterQuery]);

  useEffect(() => {
    if (!onFilterChange) return;
    const query = searchQuery.trim() || null;
    if (!query) {
      onFilterChange(null, null);
      return;
    }
    onFilterChange(query, filterProjection.paths);
  }, [filterProjection.paths, onFilterChange, searchQuery]);

  useEffect(() => {
    if (!selectedPath) return;
    const visibleSelectedPath =
      [...filterProjection.previousPathAliases].find(
        ([, path]) => path === selectedPath,
      )?.[0] ?? selectedPath;
    for (const path of model.getSelectedPaths()) {
      if (path !== visibleSelectedPath) model.getItem(path)?.deselect();
    }
    const item = model.getItem(visibleSelectedPath);
    if (!item?.isSelected()) item?.select();
    model.scrollToPath(visibleSelectedPath, {
      focus: false,
      offset: 'nearest',
    });
  }, [filterProjection.previousPathAliases, model, selectedPath]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    model.setComposition(model.getComposition());
  }, [model, reviewMapByPath]);

  const selectedReviewStatus = selectedPath
    ? reviewMapByPath?.get(selectedPath)
    : null;

  return (
    <div className="diff-tree-host">
      <FileTree
        aria-label={
          reviewMapByPath ? 'Changed files with review status' : 'Changed files'
        }
        header={
          <TreeHeader
            files={files}
            filterId={filterId}
            filterQuery={searchQuery}
            onFilterQueryChange={setSearchQuery}
            reviewMapByPath={reviewMapByPath}
          />
        }
        model={model}
        style={{ height: '100%' }}
      />
      {selectedReviewStatus ? (
        <p aria-live="polite" className="sr-only">
          {fileReviewMapStatusLabel(selectedReviewStatus, true)}
        </p>
      ) : null}
    </div>
  );
}

function TreeHeader({
  files,
  filterId,
  filterQuery,
  onFilterQueryChange,
  reviewMapByPath,
}: {
  files: DiffFilePatch[];
  filterId: string;
  filterQuery: string;
  onFilterQueryChange: (value: string) => void;
  reviewMapByPath?: ReadonlyMap<string, FileReviewMapEntry>;
}) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const largeSet = files.length > expandedTreeFileLimit;
  const hasReviewStatus = [...(reviewMapByPath?.values() ?? [])].some(
    fileReviewMapHasStatus,
  );
  return (
    <div className="border-b border-line px-2 py-1.5 font-mono text-[10px] text-muted">
      <div className="flex items-center justify-between gap-2">
        <span>files</span>
        <span className="text-primary">
          +{additions} -{deletions}
          {largeSet ? <span className="text-muted"> - large set</span> : null}
        </span>
      </div>
      {hasReviewStatus ? (
        <p
          className="mt-1 truncate text-[9px] text-muted"
          title="Review map: T unresolved threads, D local drafts, S stale drafts, N Neon findings"
        >
          review map · T threads · D drafts · S stale · N Neon
        </p>
      ) : null}
      <label className="sr-only" htmlFor={filterId}>
        Filter changed files by current path, previous path, or Neon finding
        summary
      </label>
      <input
        aria-label="Filter changed files by path or Neon finding"
        className="diff-tree-filter"
        id={filterId}
        onChange={(event) => onFilterQueryChange(event.currentTarget.value)}
        placeholder="filter paths or Neon findings"
        type="search"
        value={filterQuery}
      />
    </div>
  );
}

export function fileReviewMapHasStatus(entry: FileReviewMapEntry) {
  return (
    entry.unresolvedThreadCount > 0 ||
    entry.draftCount > 0 ||
    entry.staleDraftCount > 0 ||
    entry.findingCount > 0
  );
}

export function fileReviewMapDecoration(entry: FileReviewMapEntry) {
  return [
    entry.unresolvedThreadCount > 0 ? `T${entry.unresolvedThreadCount}` : null,
    entry.draftCount > 0 ? `D${entry.draftCount}` : null,
    entry.staleDraftCount > 0 ? `S${entry.staleDraftCount}` : null,
    entry.findingCount > 0 ? `N${entry.findingCount}` : null,
    entry.findingCount > 0 ? entry.highestFindingSeverity : null,
  ]
    .filter(Boolean)
    .join(' ');
}

export function fileReviewMapStatusLabel(
  entry: FileReviewMapEntry,
  includePath = false,
) {
  const status = [
    countLabel(entry.unresolvedThreadCount, 'unresolved review thread'),
    countLabel(entry.draftCount, 'local draft'),
    countLabel(entry.staleDraftCount, 'stale draft'),
    countLabel(entry.findingCount, 'Neon finding'),
    entry.findingCount > 0 && entry.highestFindingSeverity
      ? `highest severity ${entry.highestFindingSeverity}`
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const label = status || 'no review items';
  return includePath ? `${entry.path}: ${label}.` : label;
}

function countLabel(count: number, label: string) {
  return count > 0 ? `${count} ${label}${count === 1 ? '' : 's'}` : null;
}

function gitStatusEntry(file: DiffFilePatch): GitStatusEntry | null {
  const status = file.status.toLowerCase();
  if (status === 'a' || status === 'added') {
    return { path: file.path, status: 'added' };
  }
  if (status === 'd' || status === 'deleted' || status === 'removed') {
    return { path: file.path, status: 'deleted' };
  }
  if (status === 'r' || status === 'renamed') {
    return { path: file.path, status: 'renamed' };
  }
  if (status === '??' || status === 'untracked') {
    return { path: file.path, status: 'untracked' };
  }
  if (status) return { path: file.path, status: 'modified' };
  return null;
}

export function fileTreeFilterProjection(
  files: readonly DiffFilePatch[],
  query: string,
  reviewMapByPath: ReadonlyMap<string, FileReviewMapEntry> | undefined,
  occupiedPaths: ReadonlySet<string>,
) {
  const normalized = query.trim().toLocaleLowerCase();
  const previousPathAliases = new Map<string, string>();
  if (!normalized) {
    const paths = files.map((file) => file.path);
    return { paths, previousPathAliases, treePaths: paths };
  }
  const paths: string[] = [];
  const treePaths: string[] = [];
  for (const file of files) {
    const previousPath = file.previousPath?.trim();
    const currentMatches = file.path.toLocaleLowerCase().includes(normalized);
    const previousMatches = Boolean(
      previousPath?.toLocaleLowerCase().includes(normalized),
    );
    const summaryMatches =
      reviewMapByPath
        ?.get(file.path)
        ?.findingSummaries.some((summary) =>
          summary.toLocaleLowerCase().includes(normalized),
        ) ?? false;
    if (!currentMatches && !previousMatches && !summaryMatches) continue;
    paths.push(file.path);
    if (
      previousMatches &&
      !currentMatches &&
      !summaryMatches &&
      previousPath &&
      previousPath !== file.path &&
      !occupiedPaths.has(previousPath) &&
      !occupiedPaths.has(`${previousPath}/`)
    ) {
      previousPathAliases.set(previousPath, file.path);
      treePaths.push(previousPath);
    } else {
      treePaths.push(file.path);
    }
  }
  return { paths, previousPathAliases, treePaths };
}

function occupiedFileTreePaths(paths: readonly string[]) {
  const occupied = new Set<string>();
  for (const path of paths) {
    occupied.add(path);
    for (
      let index = path.indexOf('/');
      index >= 0;
      index = path.indexOf('/', index + 1)
    ) {
      const directory = path.slice(0, index);
      if (!directory) continue;
      occupied.add(directory);
      occupied.add(`${directory}/`);
    }
  }
  return occupied;
}

const treeUnsafeCss = `
  :host {
    --trees-bg-override: transparent;
    --trees-fg-override: var(--ink);
    --trees-fg-muted-override: var(--muted);
    --trees-border-color-override: var(--line);
    --trees-font-family-override: var(--font-mono);
    --trees-font-size-override: calc(10px * var(--deck-text-scale));
    --trees-selected-bg-override: color-mix(in srgb, var(--primary) 18%, transparent);
    --trees-bg-muted-override: color-mix(in srgb, var(--primary) 9%, transparent);
    display: block;
    height: 100%;
    min-height: 0;
  }
  button[data-type='item'] {
    border-radius: 0;
  }
  input {
    border-radius: 0;
    border-color: var(--trees-border-color-override);
    background: var(--trees-bg-muted-override);
    color: var(--trees-fg-override);
    font-family: var(--trees-font-family-override);
  }
  input::placeholder {
    color: var(--trees-fg-muted-override);
  }
  input:focus {
    outline: 1px solid var(--trees-selected-bg-override);
    outline-offset: 0;
  }
  [data-item-section='decoration'] {
    color: var(--trees-fg-override);
    font-variant-numeric: tabular-nums;
  }
`;

export function fileTreeSummary(files: DiffFilePatch[]) {
  if (files.length === 0) return 'No files';
  const first = files[0];
  return `${files.length} files · ${first ? diffStatsLabel(first) : ''}`;
}

function fileTreeModelKey(paths: string[]) {
  let hash = 2166136261;
  for (const path of paths) {
    for (let index = 0; index < path.length; index += 1) {
      hash ^= path.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${paths.length}:${hash >>> 0}`;
}
