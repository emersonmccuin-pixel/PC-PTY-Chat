// Section 2g — per-project field schemas editor.
//
// Bulk-PUT shape (server rebuilds the table on every save). Keeps explicit ids
// across edits so existing WorkItem.fields keys stay stable. Confirm prompts
// when a save would reduce the schema count (catches accidental wipes per the
// 2b session log finding).

import { useEffect, useMemo, useState } from 'react';

import { workItemsApi, type FieldSchema, type FieldSchemaInput, type FieldSchemaType } from '@/features/work-items/client';

const TYPE_OPTIONS: { value: FieldSchemaType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'enum', label: 'Enum' },
  { value: 'date', label: 'Date' },
];

interface DraftRow extends FieldSchemaInput {
  /** UI-only fingerprint; stable across re-renders. */
  rowId: string;
}

let rowIdCounter = 0;
function newRowId(): string {
  rowIdCounter += 1;
  return `r${rowIdCounter}`;
}

function rowFromSchema(s: FieldSchema): DraftRow {
  return {
    rowId: newRowId(),
    id: s.id,
    key: s.key,
    label: s.label,
    type: s.type,
    options: s.options ? [...s.options] : undefined,
    default: s.default,
    required: s.required,
    description: s.description ?? '',
    order: s.order,
  };
}

function blankRow(order: number): DraftRow {
  return {
    rowId: newRowId(),
    key: '',
    label: '',
    type: 'text',
    required: false,
    description: '',
    order,
  };
}

export function FieldSchemasEditor({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [loadedSig, setLoadedSig] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  function load() {
    workItemsApi.listFieldSchemas(projectId)
      .then((items) => {
        const next = items.map(rowFromSchema);
        setRows(next);
        setLoadedSig(JSON.stringify(next.map(toInput)));
        setErr(null);
        setSaved(null);
      })
      .catch((e) => setErr((e as Error).message));
  }

  useEffect(() => {
    setRows(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const dirty = useMemo(() => {
    if (rows === null) return false;
    return JSON.stringify(rows.map(toInput)) !== loadedSig;
  }, [rows, loadedSig]);

  if (rows === null) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  function update(idx: number, patch: Partial<DraftRow>) {
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx]!, ...patch };
      return next;
    });
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setRows((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
      return reorder(next);
    });
  }

  function moveDown(idx: number) {
    setRows((prev) => {
      if (!prev) return prev;
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!];
      return reorder(next);
    });
  }

  function remove(idx: number) {
    setRows((prev) => (prev ? reorder(prev.filter((_, i) => i !== idx)) : prev));
  }

  function add() {
    setRows((prev) => [...(prev ?? []), blankRow((prev?.length ?? 0))]);
  }

  async function save() {
    if (!rows || busy) return;
    const validationErr = validateRows(rows);
    if (validationErr) {
      setErr(validationErr);
      return;
    }
    const incomingCount = rows.length;
    const loadedCount = (JSON.parse(loadedSig || '[]') as unknown[]).length;
    if (incomingCount < loadedCount) {
      const removed = loadedCount - incomingCount;
      const ok = window.confirm(
        `${removed} field schema${removed === 1 ? '' : 's'} will be deleted. Continue?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const next = await workItemsApi.replaceFieldSchemas(projectId, rows.map(toInput));
      const nextRows = next.map(rowFromSchema);
      setRows(nextRows);
      setLoadedSig(JSON.stringify(nextRows.map(toInput)));
      setSaved('Saved.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    load();
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No field schemas yet. Add one to define typed fields for work items.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, idx) => (
            <li key={row.rowId} className="border border-border bg-card p-3">
              <RowEditor
                row={row}
                onChange={(patch) => update(idx, patch)}
                onMoveUp={() => moveUp(idx)}
                onMoveDown={() => moveDown(idx)}
                onRemove={() => remove(idx)}
                isFirst={idx === 0}
                isLast={idx === rows.length - 1}
              />
            </li>
          ))}
        </ul>
      )}

      <button
        onClick={add}
        className="border border-border px-3 py-1 text-xs hover:bg-muted"
      >
        + Add field
      </button>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          onClick={save}
          disabled={busy || !dirty}
          className="bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={discard}
          disabled={busy || !dirty}
          className="border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          Discard
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
        {saved && <span className="text-xs text-success">{saved}</span>}
      </div>
    </div>
  );
}

function RowEditor({
  row,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  isFirst,
  isLast,
}: {
  row: DraftRow;
  onChange: (patch: Partial<DraftRow>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">#{row.order + 1}</span>
        <input
          type="text"
          value={row.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="key"
          className="flex-1 border border-border bg-background px-2 py-1 font-mono text-xs"
        />
        <input
          type="text"
          value={row.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Label"
          className="flex-1 border border-border bg-background px-2 py-1 text-xs"
        />
        <select
          value={row.type}
          onChange={(e) => onChange({ type: e.target.value as FieldSchemaType })}
          className="border border-border bg-background px-2 py-1 text-xs"
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {row.type === 'enum' && (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">Options (one per line)</div>
          <textarea
            value={(row.options ?? []).join('\n')}
            onChange={(e) =>
              onChange({
                options: e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              })
            }
            rows={3}
            className="w-full border border-border bg-background px-2 py-1 font-mono text-xs"
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1 text-xs text-foreground">
          <input
            type="checkbox"
            checked={row.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          required
        </label>
        <input
          type="text"
          value={row.description ?? ''}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Description (optional)"
          className="flex-1 border border-border bg-background px-2 py-1 text-xs"
        />
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className="border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
          aria-label="Move up"
        >
          ↑
        </button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className="border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
          aria-label="Move down"
        >
          ↓
        </button>
        <button
          onClick={onRemove}
          className="border border-destructive/60 px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function reorder(rows: DraftRow[]): DraftRow[] {
  return rows.map((r, idx) => ({ ...r, order: idx }));
}

function toInput(row: DraftRow): FieldSchemaInput {
  const out: FieldSchemaInput = {
    key: row.key.trim(),
    label: row.label.trim(),
    type: row.type,
    required: row.required,
    order: row.order,
  };
  if (row.id) out.id = row.id;
  if (row.type === 'enum' && row.options && row.options.length > 0) {
    out.options = row.options;
  }
  if (row.default !== undefined) out.default = row.default;
  if (row.description && row.description.length > 0) out.description = row.description;
  return out;
}

function validateRows(rows: DraftRow[]): string | null {
  const keys = new Set<string>();
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) return `Row #${r.order + 1}: key required.`;
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k)) {
      return `Row #${r.order + 1}: key "${k}" must start with a letter and contain only letters, digits, _ or -.`;
    }
    if (keys.has(k)) return `Duplicate key: ${k}.`;
    keys.add(k);
    if (!r.label.trim()) return `Row #${r.order + 1}: label required.`;
    if (r.type === 'enum' && (!r.options || r.options.length === 0)) {
      return `Row #${r.order + 1} ("${r.label}"): enum requires at least one option.`;
    }
  }
  return null;
}
