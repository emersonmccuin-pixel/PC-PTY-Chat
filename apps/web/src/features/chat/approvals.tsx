import { useState } from 'react';

import type { ApprovalRequiredEvent } from '@/hooks/use-project-ws';

export async function respondToApproval(
  projectId: string,
  workflowRunId: string,
  nodeId: string,
  approved: boolean,
  response: string,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/approval/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowRunId, nodeId, approved, response }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!res.ok || data.ok === false) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
}

export interface ApprovalBubbleProps {
  event: ApprovalRequiredEvent;
  projectId: string;
  resolved?: { approved: boolean; response: string };
  onResolved: (
    workflowRunId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ) => void;
}

export function ApprovalBubble({
  event,
  projectId,
  resolved,
  onResolved,
}: ApprovalBubbleProps) {
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(approved: boolean, response: string) {
    setBusy(true);
    setError(null);
    try {
      await respondToApproval(projectId, event.workflowRunId, event.nodeId, approved, response);
      onResolved(event.workflowRunId, event.nodeId, approved, response);
    } catch (err) {
      setError(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="bg-warning px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
          approval required
        </span>
      </div>
      <div className="mb-2 text-sm text-foreground">{event.message ?? '(no message)'}</div>
      {resolved ? (
        <div className="text-xs text-muted-foreground">
          {resolved.approved
            ? 'Approved.'
            : `Rejected${resolved.response ? ` \u2014 ${resolved.response}` : ''}.`}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit(true, '')}
              className="bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowReject(true)}
              className="bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
          {showReject && (
            <div className="flex flex-col gap-1">
              {event.on_reject_prompt && (
                <div className="text-xs text-muted-foreground">{event.on_reject_prompt}</div>
              )}
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder={event.on_reject_prompt ?? 'Optional reason'}
                className="border border-border bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit(false, reason)}
                className="self-start bg-destructive px-3 py-1 text-xs font-medium uppercase tracking-wider text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                Submit reject
              </button>
            </div>
          )}
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}
