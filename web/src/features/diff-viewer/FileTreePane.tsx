import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import { useEffect, useMemo, useRef } from 'react';
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
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus,
    initialExpansion,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 24,
    onSelectionChange(selectedPaths) {
      const nextPath = [...selectedPaths]
        .reverse()
        .find((path) => filePathSet.has(path));
      if (nextPath) onSelectPath(nextPath);
    },
    preparedInput,
    renderRowDecoration({ item }) {
      if (item.kind !== 'file') return null;
      const entry = reviewMapRef.current?.get(item.path);
      return entry && fileReviewMapHasStatus(entry)
        ? {
            text: fileReviewMapDecoration(entry),
            title: fileReviewMapStatusLabel(entry),
          }
        : null;
    },
    search: true,
    searchBlurBehavior: 'retain',
    unsafeCSS: treeUnsafeCss,
  });
  const search = useFileTreeSearch(model);
  const appliedFilterQuery = useRef<{
    initialized: boolean;
    value: string | null | undefined;
  }>({ initialized: false, value: undefined });
  const pendingExternalFilter = useRef<{
    active: boolean;
    value: string | null;
  }>({ active: false, value: null });

  useEffect(() => {
    if (
      appliedFilterQuery.current.initialized &&
      appliedFilterQuery.current.value === filterQuery
    ) {
      return;
    }
    appliedFilterQuery.current = { initialized: true, value: filterQuery };
    const currentQuery = search.value.trim() || null;
    if (filterQuery === undefined || filterQuery === currentQuery) return;
    pendingExternalFilter.current = {
      active: true,
      value: filterQuery?.trim() || null,
    };
    search.setValue(filterQuery);
  }, [filterQuery, search]);

  useEffect(() => {
    if (!onFilterChange) return;
    const query = search.value.trim() || null;
    if (pendingExternalFilter.current.active) {
      if (pendingExternalFilter.current.value !== query) return;
      pendingExternalFilter.current.active = false;
    }
    if (!query) {
      onFilterChange(null, null);
      return;
    }
    const normalized = query.toLocaleLowerCase();
    const matchingPaths = new Set(
      search.matchingPaths.filter((path) => filePathSet.has(path)),
    );
    for (const file of files) {
      if (file.previousPath?.toLocaleLowerCase().includes(normalized)) {
        matchingPaths.add(file.path);
      }
    }
    onFilterChange(
      query,
      paths.filter((path) => matchingPaths.has(path)),
    );
  }, [
    filePathSet,
    files,
    filterQuery,
    onFilterChange,
    paths,
    search.matchingPaths,
    search.value,
  ]);

  useEffect(() => {
    if (!selectedPath) return;
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedPath) model.getItem(path)?.deselect();
    }
    const item = model.getItem(selectedPath);
    if (!item?.isSelected()) item?.select();
    model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' });
  }, [model, selectedPath]);

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
        header={<TreeHeader files={files} reviewMapByPath={reviewMapByPath} />}
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
  reviewMapByPath,
}: {
  files: DiffFilePatch[];
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
