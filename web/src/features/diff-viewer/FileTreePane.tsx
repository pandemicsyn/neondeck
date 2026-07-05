import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useMemo } from 'react';
import {
  prepareFileTreeInput,
  type FileTreeInitialExpansion,
  type FileTreePreparedInput,
  type GitStatusEntry,
} from '@pierre/trees';
import { diffStatsLabel } from './helpers';
import type { DiffFilePatch } from './types';

const expandedTreeFileLimit = 120;

type FileTreePaneProps = {
  files: DiffFilePatch[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
};

export function FileTreePane({
  files,
  selectedPath,
  onSelectPath,
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
      gitStatus={gitStatus}
      initialExpansion={initialExpansion}
      key={treeKey}
      onSelectPath={onSelectPath}
      paths={paths}
      preparedInput={preparedInput}
      selectedPath={selectedPath}
    />
  );
}

function FileTreePaneModel({
  files,
  gitStatus,
  initialExpansion,
  onSelectPath,
  paths,
  preparedInput,
  selectedPath,
}: FileTreePaneProps & {
  gitStatus: GitStatusEntry[];
  initialExpansion: FileTreeInitialExpansion;
  paths: string[];
  preparedInput: FileTreePreparedInput;
}) {
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
    search: true,
    searchBlurBehavior: 'retain',
    unsafeCSS: treeUnsafeCss,
  });

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

  return (
    <div className="diff-tree-host">
      <FileTree
        aria-label="Changed files"
        header={<TreeHeader files={files} />}
        model={model}
        style={{ height: '100%' }}
      />
    </div>
  );
}

function TreeHeader({ files }: { files: DiffFilePatch[] }) {
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const largeSet = files.length > expandedTreeFileLimit;
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5 font-mono text-[10px] text-muted">
      <span>files</span>
      <span className="text-primary">
        +{additions} -{deletions}
        {largeSet ? <span className="text-muted"> - large set</span> : null}
      </span>
    </div>
  );
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
