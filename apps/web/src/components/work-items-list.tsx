import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, type Project, type WorkItem, type WorkItemStatus } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const STATUS_VARIANT: Record<WorkItemStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  'in-progress': 'secondary',
  blocked: 'destructive',
  complete: 'default',
  failed: 'destructive',
};

export function WorkItemsList() {
  const [project, setProject] = useState<Project | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const [p, items] = await Promise.all([api.project(), api.workItems()]);
      setProject(p);
      setWorkItems(items);
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError && !project) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Failed to load: {loadError}</p>
        <Button className="mt-3" size="sm" onClick={() => void reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!project) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const stagesSorted = [...project.stages].sort((a, b) => a.order - b.order);

  return (
    <div className="p-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{project.name}</h2>
          <p className="text-sm text-muted-foreground">
            {workItems.length} work item{workItems.length === 1 ? '' : 's'} ·{' '}
            {stagesSorted.length} stage{stagesSorted.length === 1 ? '' : 's'}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void reload()} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      <CreateForm
        stages={stagesSorted}
        onCreated={() => void reload()}
        onError={setActionError}
      />

      {actionError && (
        <p className="mt-3 text-sm text-destructive">{actionError}</p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {stagesSorted.map((stage) => {
          const inStage = workItems.filter((wi) => wi.stageId === stage.id);
          return (
            <section key={stage.id} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <span>{stage.name}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {inStage.length}
                </Badge>
              </h3>
              {inStage.length === 0 && (
                <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  empty
                </p>
              )}
              {inStage.map((wi) => (
                <WorkItemCard
                  key={wi.id}
                  workItem={wi}
                  stages={stagesSorted}
                  onMoved={() => void reload()}
                  onError={setActionError}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CreateForm({
  stages,
  onCreated,
  onError,
}: {
  stages: { id: string; name: string }[];
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!stageId && stages[0]) setStageId(stages[0].id);
  }, [stages, stageId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setSubmitting(true);
    onError(null);
    try {
      await api.createWorkItem(trimmed, stageId);
      setTitle('');
      onCreated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="New work item title…"
        className="flex h-9 min-w-[16rem] flex-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      />
      <select
        value={stageId}
        onChange={(e) => setStageId(e.target.value)}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
      >
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
        {submitting ? 'Creating…' : 'Create'}
      </Button>
    </form>
  );
}

function WorkItemCard({
  workItem,
  stages,
  onMoved,
  onError,
}: {
  workItem: WorkItem;
  stages: { id: string; name: string }[];
  onMoved: () => void;
  onError: (msg: string | null) => void;
}) {
  const [moving, setMoving] = useState(false);

  async function move(toStage: string) {
    if (toStage === workItem.stageId) return;
    setMoving(true);
    onError(null);
    try {
      await api.moveWorkItem(workItem.id, toStage);
      onMoved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setMoving(false);
    }
  }

  const status = workItem.status ?? 'pending';

  return (
    <Card className="gap-2 py-3">
      <CardHeader className="px-3">
        <CardTitle className="flex items-start justify-between gap-2 text-sm">
          <span className="break-words">{workItem.title}</span>
          <Badge variant={STATUS_VARIANT[status]} className="shrink-0">
            {status}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-1">
        <p className="font-mono text-[10px] text-muted-foreground">{workItem.id}</p>
        {workItem.statusReason && (
          <p className="mt-1 text-xs text-muted-foreground">{workItem.statusReason}</p>
        )}
        <select
          value={workItem.stageId}
          onChange={(e) => void move(e.target.value)}
          disabled={moving}
          className={cn(
            'mt-2 h-7 w-full rounded-md border border-input bg-background px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            moving && 'opacity-50',
          )}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === workItem.stageId ? `${s.name} (current)` : `→ ${s.name}`}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  );
}
