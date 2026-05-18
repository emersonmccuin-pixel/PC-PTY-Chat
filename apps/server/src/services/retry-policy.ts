// Pure retry-decision helpers (4a.7 / D17). Extracted from workflow-runtime
// so the decision logic is unit-testable without instantiating the runtime
// + DB stack. The runtime's `tryRetry` composes these with the side-effects
// (nodeOutput mutation + setTimeout).

import type { BaseNode, RetryCause } from '@pc/domain';

/** Decide whether a failed node should retry. Pure — no side effects. */
export function shouldRetry(
  node: Pick<BaseNode, 'retry'>,
  currentAttempt: number,
  cause: RetryCause,
): boolean {
  if (!node.retry) return false;
  if (currentAttempt >= node.retry.max_attempts) return false;
  const on = node.retry.on ?? ['failed'];
  return on.includes(cause);
}

/** Detect retry cause from a NodeOutput.error string. Bash/script/http
 *  dispatchers format timeout errors as "timeout (...ms exceeded)" — string
 *  detection is pragmatic for v1. */
export function detectRetryCause(error: string | undefined): RetryCause {
  return error?.startsWith('timeout (') ? 'timeout' : 'failed';
}
