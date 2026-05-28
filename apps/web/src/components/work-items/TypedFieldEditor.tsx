// Section 2g — per-FieldSchema typed input renderer.
//
// Used by the WorkItem detail modal's Overview tab. Pure presentational —
// state lives in the parent's draft.fields map. Date values are persisted as
// ms-epoch numbers; the input renders ISO yyyy-mm-dd derived from the value.

import type { FieldSchema } from '@/features/work-items/client';

interface TypedFieldEditorProps {
  schema: FieldSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  error?: string | null;
}

export function TypedFieldEditor({ schema, value, onChange, error }: TypedFieldEditorProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-baseline gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span>{schema.label}</span>
        {schema.required && <span className="text-destructive">*</span>}
        <span className="ml-1 font-mono text-[10px] normal-case tracking-normal text-muted-foreground/60">
          {schema.key}
        </span>
      </label>
      {renderInput(schema, value, onChange)}
      {schema.description && (
        <p className="text-[11px] text-muted-foreground">{schema.description}</p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

function renderInput(
  schema: FieldSchema,
  value: unknown,
  onChange: (next: unknown) => void,
): React.ReactNode {
  const base = 'w-full border border-border bg-background px-2 py-1 text-sm';
  switch (schema.type) {
    case 'text':
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => {
            const s = e.target.value;
            if (s === '') {
              onChange(null);
              return;
            }
            const n = Number(s);
            onChange(Number.isFinite(n) ? n : s);
          }}
          className={base}
        />
      );
    case 'boolean':
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="text-muted-foreground">
            {value === true ? 'true' : 'false'}
          </span>
        </label>
      );
    case 'enum': {
      const options = schema.options ?? [];
      const current = typeof value === 'string' ? value : '';
      return (
        <select
          value={current}
          onChange={(e) => onChange(e.target.value || null)}
          className={base}
        >
          <option value="">— none —</option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    case 'date': {
      const iso = isoFromValue(value);
      return (
        <input
          type="date"
          value={iso}
          onChange={(e) => {
            const s = e.target.value;
            if (!s) {
              onChange(null);
              return;
            }
            const ms = Date.parse(s);
            onChange(Number.isFinite(ms) ? ms : s);
          }}
          className={base}
        />
      );
    }
    default:
      return null;
  }
}

function isoFromValue(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v).toISOString().slice(0, 10);
  }
  if (typeof v === 'string' && v.length > 0) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  }
  return '';
}
