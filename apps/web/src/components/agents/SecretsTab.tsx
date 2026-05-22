// Section 17d.6 — Secrets tab.
//
// v1 stores values plaintext in the DB; banner makes that visible. Server
// never echoes the value back, so the only "edit" path is delete + recreate
// (matches the "click-to-overwrite (never readback)" buildout call).
//
// API surface used:
//   - api.createSecret(podId, { envVarName, valuePlaintext })
//   - api.deleteSecret(podId, secretId)
//
// Both mutations emit a `pod-changed` envelope that refreshes the parent's
// bundle (passed in via the `onChanged` callback).

import { useState } from 'react';

import { api, type PodBundle, type ULID } from '@/api/client';

interface SecretsTabProps {
  podId: ULID;
  bundle: PodBundle | null;
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

interface NewSecretDraft {
  envVarName: string;
  value: string;
}

const BLANK: NewSecretDraft = { envVarName: '', value: '' };

export function SecretsTab({ podId, bundle, loading, error, onChanged }: SecretsTabProps) {
  const [draft, setDraft] = useState<NewSecretDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  async function addSecret() {
    if (!draft || busy) return;
    const name = draft.envVarName.trim();
    if (!name) {
      setOpError('Environment variable name is required.');
      return;
    }
    if (!draft.value) {
      setOpError('Value cannot be empty.');
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      await api.createSecret(podId, { envVarName: name, valuePlaintext: draft.value });
      setDraft(null);
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSecret(secretId: ULID, envVarName: string) {
    const ok = window.confirm(`Delete secret ${envVarName}?`);
    if (!ok) return;
    setBusy(true);
    setOpError(null);
    try {
      await api.deleteSecret(podId, secretId);
      onChanged();
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-xs text-muted-foreground">Loading…</div>;
  if (error) return <div className="text-xs text-destructive">{error}</div>;
  if (!bundle) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="border border-yellow-700/40 bg-yellow-700/10 px-3 py-2 text-xs text-yellow-200">
        <strong className="font-semibold">v1 plaintext storage.</strong> Values are
        stored unencrypted in the local SQLite DB. v2 will swap to OS-level
        encryption. Don't commit your data dir.
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {bundle.secrets.length} {bundle.secrets.length === 1 ? 'secret' : 'secrets'}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpError(null);
            setDraft(BLANK);
          }}
          disabled={busy || draft !== null}
          className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          + Add secret
        </button>
      </div>

      {opError && (
        <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {opError}
        </div>
      )}

      {draft && (
        <div className="border border-primary/60 bg-card px-3 py-2">
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Env var name
              </span>
              <input
                type="text"
                value={draft.envVarName}
                onChange={(e) =>
                  setDraft((p) => (p ? { ...p, envVarName: e.target.value } : p))
                }
                placeholder="OPENAI_API_KEY"
                className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Value
              </span>
              <input
                type="password"
                value={draft.value}
                onChange={(e) => setDraft((p) => (p ? { ...p, value: e.target.value } : p))}
                placeholder="sk-…"
                className="w-full border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              disabled={busy}
              className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={addSecret}
              disabled={busy}
              className="border border-primary bg-primary/30 px-2 py-1 text-xs font-medium text-foreground hover:bg-primary/50 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {bundle.secrets.length === 0 && !draft ? (
        <div className="border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No secrets yet. Click + Add secret to register one.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {bundle.secrets.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 border border-border bg-card px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-xs font-medium text-foreground">
                  {s.envVarName}
                </div>
                <div className="font-mono text-xs text-muted-foreground">••••••••</div>
              </div>
              <button
                type="button"
                onClick={() => void removeSecret(s.id, s.envVarName)}
                disabled={busy}
                className="border border-destructive/60 bg-card px-2 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
