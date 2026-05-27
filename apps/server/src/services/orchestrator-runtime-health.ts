export type RuntimeHealth =
  | 'not_spawned'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'respawning'
  | 'failed_resume'
  | 'provider_missing';

export type RuntimeWaitPoint =
  | 'session'
  | 'queue'
  | 'spawn'
  | 'jsonl'
  | 'provider_resume'
  | 'ready_state'
  | 'none';

export type PtyLifecycleState =
  | 'stopped'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'thinking'
  | 'exited'
  | 'failed'
  | null;

export interface RuntimeHealthInput {
  ptyState: PtyLifecycleState;
  lastExitAt?: number | null;
  failureHealth?: 'failed_resume' | 'provider_missing' | null;
}

export interface RuntimeWaitPointInput {
  sessionId?: string | null;
  health: RuntimeHealth;
  queueDepth?: number;
  rawJsonlExists?: boolean;
  lastJsonlAt?: number | null;
}

export function deriveRuntimeHealth(input: RuntimeHealthInput): RuntimeHealth {
  if (input.failureHealth) return input.failureHealth;

  switch (input.ptyState) {
    case 'stopped':
      return 'not_spawned';
    case 'spawning':
      return input.lastExitAt ? 'respawning' : 'spawning';
    case 'ready':
      return 'ready';
    case 'busy':
    case 'thinking':
      return 'busy';
    case 'failed':
      return 'failed_resume';
    case 'exited':
      return 'exited';
    case null:
      return 'not_spawned';
  }
}

export function deriveRuntimeWaitPoint(input: RuntimeWaitPointInput): RuntimeWaitPoint {
  if (!input.sessionId) return 'session';

  if (input.health === 'provider_missing' || input.health === 'failed_resume') {
    return 'provider_resume';
  }

  if ((input.queueDepth ?? 0) > 0) return 'queue';

  if (
    input.health === 'not_spawned' ||
    input.health === 'spawning' ||
    input.health === 'respawning' ||
    input.health === 'exited'
  ) {
    return 'spawn';
  }

  if (input.health === 'busy') {
    return input.rawJsonlExists && input.lastJsonlAt ? 'ready_state' : 'jsonl';
  }

  return 'none';
}
