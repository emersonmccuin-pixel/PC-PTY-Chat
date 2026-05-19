// 5+.2 — LeftRail body when the rail mode is "files". Renders the active
// project's file tree (server walks folderPath applying HARD_SKIP_DIRS +
// .gitignore). Clicking a file selects it for the center-column FilesViewer
// and auto-switches the tab to 'files'.

import { useEffect, useMemo, useState } from 'react';

import { api, type FileTreeNode, type Project } from '@/api/client';
import { usePerProjectTab } from '@/store/per-project-tab';
import { useViewingFile } from '@/store/viewing-file';

interface FilesRailProps {
  project: Project | null;
}

export function FilesRail({ project }: FilesRailProps) {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-project expand state — paths of directories the user has opened.
  // Rendered fresh on each project switch so a new project starts collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selectedPath = useViewingFile((s) =>
    project ? s.bySlug[project.slug] ?? null : null,
  );
  const setViewing = useViewingFile((s) => s.setViewing);
  const setTab = usePerProjectTab((s) => s.setTab);

  useEffect(() => {
    setExpanded(new Set());
    if (!project) {
      setTree([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getFilesTree(project.id)
      .then((rows) => {
        if (!cancelled) setTree(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  const isEmpty = useMemo(() => !loading && !error && tree.length === 0, [
    loading,
    error,
    tree,
  ]);

  function toggleDir(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function pickFile(path: string) {
    if (!project) return;
    setViewing(project.slug, path);
    setTab(project.slug, 'files');
  }

  if (!project) {
    return (
      <div className="flex h-full flex-col bg-card text-foreground">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Files
        </div>
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Select a project to browse its files.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card text-foreground">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Files
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && tree.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {error && (
          <div className="px-3 py-3 text-xs text-destructive">Error: {error}</div>
        )}
        {isEmpty && (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            No files here (everything got skipped by .gitignore or the hard-skip list).
          </div>
        )}
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggleDir={toggleDir}
            onPickFile={pickFile}
          />
        ))}
      </div>
    </div>
  );
}

interface TreeRowProps {
  node: FileTreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onPickFile: (path: string) => void;
}

function TreeRow({
  node,
  depth,
  expanded,
  selectedPath,
  onToggleDir,
  onPickFile,
}: TreeRowProps) {
  const isOpen = expanded.has(node.path);
  const isSelected = node.kind === 'file' && selectedPath === node.path;
  const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };

  if (node.kind === 'dir') {
    return (
      <>
        <button
          onClick={() => onToggleDir(node.path)}
          title={node.path}
          style={indent}
          className="block w-full truncate py-1 pr-2 text-left text-xs text-foreground/80 hover:bg-muted"
        >
          <span className="mr-1 inline-block w-3 text-muted-foreground">
            {isOpen ? '▾' : '▸'}
          </span>
          {node.name}
        </button>
        {isOpen &&
          node.children?.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onPickFile={onPickFile}
            />
          ))}
      </>
    );
  }

  return (
    <button
      onClick={() => onPickFile(node.path)}
      title={node.path}
      style={indent}
      className={
        'block w-full truncate border-l-2 py-1 pr-2 text-left text-xs hover:bg-muted ' +
        (isSelected
          ? 'border-primary bg-muted text-primary'
          : 'border-transparent text-foreground/80')
      }
    >
      <span className="mr-1 inline-block w-3" />
      {node.name}
    </button>
  );
}
