// WorkItem domain type. The unit of work that flows between project stages.
// In the rig, persisted as an entry in data/work-items.json. In PC, a row in sqlite.

export type WorkItemStatus = 'pending' | 'in-progress' | 'blocked' | 'complete' | 'failed';

export interface WorkItemHistoryEntry {
  ts: string;
  /** 'move' for stage transitions, 'update' for field merges. */
  kind: 'move' | 'update';
  from?: string;
  to?: string;
  fields?: Record<string, unknown>;
  /** Free-form note (e.g. workflow runtime annotations). */
  note?: string;
}

export interface WorkItem {
  id: string;
  title: string;
  /**
   * Free-form body text. PC has it; rig keeps it optional so existing seeds
   * don't have to populate it. Slice 8b's input mappings can reference
   * `workItem.body` once workflows start consuming it.
   */
  body?: string;
  stageId: string;
  /** Slice 6.5: in-progress while a workflow run is open; blocked on contract failure or safety-net hit. Default `pending`. */
  status?: WorkItemStatus;
  /** Reason for the current status when not `pending` — surfaced in the UI. */
  statusReason?: string;
  fields: Record<string, unknown>;
  history: WorkItemHistoryEntry[];
}
