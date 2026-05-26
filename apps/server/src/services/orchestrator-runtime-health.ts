export type RuntimeHealth =
  | 'not_spawned'
  | 'spawning'
  | 'ready'
  | 'busy'
  | 'exited'
  | 'respawning'
  | 'failed_resume'
  | 'provider_missing';

export type PtyLifecycleState = 'spawning' | 'ready' | 'thinking' | 'exited' | null;

export interface RuntimeHealthInput {
  ptyState: PtyLifecycleState;
  lastExitAt?: number | null;
  failureHealth?: 'failed_resume' | 'provider_missing' | null;
}

export function deriveRuntimeHealth(input: RuntimeHealthInput): RuntimeHealth {
  if (input.failureHealth) return input.failureHealth;

  switch (input.ptyState) {
    case 'spawning':
      return input.lastExitAt ? 'respawning' : 'spawning';
    case 'ready':
      return 'ready';
    case 'thinking':
      return 'busy';
    case 'exited':
      return 'exited';
    case null:
      return 'not_spawned';
  }
}
