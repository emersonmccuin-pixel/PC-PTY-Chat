// 5+.2 — center-column viewer for the file selected in FilesRail. Dispatches
// on the server's preview `kind`: markdown / html / image / text / binary /
// oversized. Editing is out of scope (D91); this is a read-only surface.

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { api, type FilePreview, type Project } from '@/api/client';
import { useViewingFile } from '@/store/viewing-file';

interface FilesViewerProps {
  project: Project;
}

export function FilesViewer({ project }: FilesViewerProps) {
  const path = useViewingFile((s) => s.bySlug[project.slug] ?? null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .previewFile(project.id, path)
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setPreview(null);
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, path]);

  if (!path) {
    return (
      <div className="grid h-full place-items-center bg-background text-sm text-muted-foreground">
        Select a file in the Files rail to preview it here.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="truncate font-mono text-xs text-foreground/80" title={path}>
          {path}
        </div>
        {preview && (
          <div className="ml-3 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            {labelForKind(preview.kind)} · {formatSize(preview.byteSize)}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="px-4 py-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {error && (
          <div className="px-4 py-3 text-xs text-destructive">Error: {error}</div>
        )}
        {preview && <PreviewBody preview={preview} path={path} />}
      </div>
    </div>
  );
}

function PreviewBody({ preview, path }: { preview: FilePreview; path: string }) {
  switch (preview.kind) {
    case 'markdown':
      return (
        <div className="markdown-body px-6 py-4">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {preview.content}
          </ReactMarkdown>
        </div>
      );
    case 'html':
      // Sandboxed — scripts and top-level navigation are disabled. srcDoc
      // means we never hit the network for the document itself.
      return (
        <iframe
          title={path}
          srcDoc={preview.content}
          sandbox=""
          className="h-full w-full border-0 bg-white"
        />
      );
    case 'image':
      return (
        <div className="grid h-full place-items-center bg-background p-4">
          <img
            src={preview.dataUri}
            alt={path}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case 'text':
      return (
        <pre className="m-0 whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs text-foreground/90">
          {preview.content}
        </pre>
      );
    case 'binary':
      return (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          Binary file — preview not supported. ({formatSize(preview.byteSize)})
        </div>
      );
    case 'oversized':
      return (
        <div className="px-4 py-3 text-xs text-muted-foreground">
          File too large to preview ({formatSize(preview.byteSize)}). 1 MB cap.
        </div>
      );
  }
}

function labelForKind(kind: FilePreview['kind']): string {
  switch (kind) {
    case 'markdown':
      return 'Markdown';
    case 'html':
      return 'HTML';
    case 'image':
      return 'Image';
    case 'text':
      return 'Text';
    case 'binary':
      return 'Binary';
    case 'oversized':
      return 'Oversized';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
