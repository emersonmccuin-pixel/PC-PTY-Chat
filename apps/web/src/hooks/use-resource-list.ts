// Section 18.10 — generic resource-list hook for Activity Panel regions.
//
// Topics 4 + 5 architecture-review locks (2026-05-21):
//   - One generic `useResourceList<T>` replaces the three near-duplicates
//     (`useProjectWorkflowRuns`, `useProjectAgentRuns`, future region hooks).
//   - WS envelopes carry full snapshots. Local Map is a CACHE keyed by id;
//     refetch on terminal-status transitions or whenever a snapshot lands
//     for an unknown id (covers WS-batched / out-of-order arrivals).
//   - Hooks never reduce over the event stream alone. B5's "only inspect
//     last event in buffer" anti-pattern is structurally impossible here:
//     the per-envelope branch only PATCHES; the refetch is the source of
//     truth on every uncertain transition.

import { useEffect, useMemo, useState } from 'react';

import type { Project } from '@/api/client';
import type { WsEnvelope } from '@/hooks/use-project-ws';

export interface ResourceListConfig<T> {
  /** WS envelope kind that carries snapshots for this resource. */
  envelopeKind: string;
  /** Extract the record from a matching envelope. Return null to skip
   *  (e.g., envelope is for a different project, missing snapshot field,
   *  or otherwise doesn't apply). The hook passes the active project id
   *  so the extractor can do its own project-match check against the
   *  envelope's `projectId` (the per-project WS is already scoped, but
   *  the defensive guard keeps the hook safe if that ever changes). */
  extractSnapshot: (env: WsEnvelope, projectId: string) => T | null;
  /** Stable id for the record — used as the map key. */
  getId: (record: T) => string;
  /** Terminal-status predicate. Terminal transitions trigger a wholesale
   *  refetch — the server's list endpoint may filter terminal rows out
   *  (agent-run case), or carry fields the envelope omits (workflow-run's
   *  completedAt). Cache stays honest. */
  isTerminal: (record: T) => boolean;
  /** When true, terminal records are removed from the local map on the
   *  per-envelope branch (and the subsequent refetch confirms). Use for
   *  resources whose list endpoint excludes terminal rows. */
  dropOnTerminal: boolean;
  /** Fetch the project's current full list. Called on mount, on project
   *  switch, and on every terminal-status / unknown-id envelope. */
  list: (projectId: string) => Promise<T[]>;
}

/** Cache-keyed-by-id resource list driven by snapshot WS envelopes. */
export function useResourceList<T>(
  project: Project | null,
  events: WsEnvelope[],
  config: ResourceListConfig<T>,
): { records: T[]; refetch: () => void } {
  const [map, setMap] = useState<Map<string, T>>(() => new Map());

  // Initial fetch + project switch.
  useEffect(() => {
    if (!project) {
      setMap(new Map());
      return;
    }
    let cancelled = false;
    void config.list(project.id).then((list) => {
      if (cancelled) return;
      setMap(new Map(list.map((r) => [config.getId(r), r])));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Per-envelope patch + refetch trigger.
  //
  // Only the LAST envelope is inspected per render — same as the previous
  // hooks. The refetch on terminal / unknown-id handles WS-batched arrivals
  // where the per-envelope branch missed an intermediate state.
  useEffect(() => {
    if (!project || events.length === 0) return;
    const last = events[events.length - 1];
    if (!last || last.type !== config.envelopeKind) return;
    const record = config.extractSnapshot(last, project.id);
    if (!record) return;

    const id = config.getId(record);
    const isTerminal = config.isTerminal(record);

    let unknown = false;
    setMap((prev) => {
      const known = prev.has(id);
      if (!known) unknown = true;
      const next = new Map(prev);
      if (isTerminal && config.dropOnTerminal) {
        next.delete(id);
      } else {
        next.set(id, record);
      }
      return next;
    });

    // Refetch on terminal transition OR on unknown id. Terminal: server
    // list may omit fields the envelope skips (completedAt) or filter the
    // row out entirely; refetch normalises. Unknown id: WS batching can
    // hide the prior `created` envelope; refetch picks up siblings.
    if (isTerminal || unknown) {
      void config.list(project.id).then((list) => {
        setMap(new Map(list.map((r) => [config.getId(r), r])));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project?.id]);

  const records = useMemo(() => Array.from(map.values()), [map]);

  return {
    records,
    refetch: () => {
      if (!project) return;
      void config.list(project.id).then((list) => {
        setMap(new Map(list.map((r) => [config.getId(r), r])));
      });
    },
  };
}
