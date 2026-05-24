// Invoke-depth cap on `pc_invoke_agent` nesting.
//
// Cap of 5 means: orchestrator (depth 1) → agent (depth 2) → … → depth 5.
// Anything deeper rejects at the invoke route before pod materialisation.

export const AGENT_INVOKE_DEPTH_CAP = 5;

/** Guard against `pc_invoke_agent` chains nesting beyond the cap. Caller
 *  passes `parentInvokeDepth` (0 from the orchestrator, otherwise the value
 *  read from `PC_AGENT_INVOKE_DEPTH`); the helper returns the child's depth
 *  on success or a `depth-cap` rejection when the cap would be exceeded.
 *  Negative inputs and NaN clamp to 0 so a malformed env var doesn't silently
 *  allow unbounded nesting. */
export function checkInvokeDepth(
  parentInvokeDepth: number,
):
  | { ok: true; childDepth: number }
  | { ok: false; cause: 'depth-cap'; error: string } {
  const safeParent =
    Number.isFinite(parentInvokeDepth) && parentInvokeDepth > 0
      ? Math.floor(parentInvokeDepth)
      : 0;
  const childDepth = safeParent + 1;
  if (childDepth > AGENT_INVOKE_DEPTH_CAP) {
    return {
      ok: false,
      cause: 'depth-cap',
      error: `pc_invoke_agent rejected: parent depth ${safeParent} would push child to ${childDepth}, exceeding cap ${AGENT_INVOKE_DEPTH_CAP}`,
    };
  }
  return { ok: true, childDepth };
}
