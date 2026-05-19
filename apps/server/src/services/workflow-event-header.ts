// Stable header tag for workflow→orchestrator channel messages (4c / D38).
// Prepended to every channel POST originating from the workflow runtime so the
// orchestrator can recognize the message kind via a stable token instead of
// matching prose phrasing.
//
// Shape: `[pc:workflow-event kind=<kind> version=<n>]`
//
// Three kinds in 4c: subagent-dispatch / terminated / orchestrator-review.
// (`subagent-dispatch` disappears after 4d lands independent execution.)

export type WorkflowEventKind = 'subagent-dispatch' | 'terminated' | 'orchestrator-review';

export function buildWorkflowEventHeader(kind: WorkflowEventKind, version = 1): string {
  return `[pc:workflow-event kind=${kind} version=${version}]`;
}
