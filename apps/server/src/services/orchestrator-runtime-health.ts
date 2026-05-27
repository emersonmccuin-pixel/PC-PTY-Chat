export type RuntimeHealth =
  | 'not_spawned'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'respawning'
  | 'failed_resume'
  | 'provider_missing';

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
