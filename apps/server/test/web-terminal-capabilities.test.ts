import assert from 'node:assert/strict';
import { test } from 'node:test';

type RuntimeStateModule = {
  orchestratorInputCapabilities: (input: {
    composerHidden: boolean;
    composerDisabled: boolean;
    startingNewSession: boolean;
    wsStatus: 'idle' | 'connecting' | 'open' | 'closed';
    runtimeHealth:
      | 'not_spawned'
      | 'spawning'
      | 'ready'
      | 'busy'
      | 'exited'
      | 'respawning'
      | 'failed_resume'
      | 'provider_missing'
      | null;
    latestRuntimeState: string | null;
  }) => {
    canAcceptChatInput: boolean;
    canSubmitChatInput: boolean;
    canAcceptTerminalInput: boolean;
    canResizeTerminal: boolean;
    canInterrupt: boolean;
    stateLabel: string;
  };
  transientInputCapabilities: (state: 'spawning' | 'ready' | 'thinking' | 'exited') => {
    canAcceptChatInput: boolean;
    canSubmitChatInput: boolean;
    canAcceptTerminalInput: boolean;
    canResizeTerminal: boolean;
    canInterrupt: boolean;
    stateLabel: string;
  };
  latestTerminalInputFailure: (events: Array<Record<string, unknown>>) => {
    status: 'invalid-message' | 'no-session' | 'write-failed';
    error: string;
    message: string;
  } | null;
};

async function loadRuntimeStateModule(): Promise<RuntimeStateModule> {
  const moduleUrl = new URL('../../web/src/features/chat/runtimeState.ts', import.meta.url).href;
  return (await import(moduleUrl)) as RuntimeStateModule;
}

test('orchestrator terminal input stays writable while runtime is spawning', async () => {
  const { orchestratorInputCapabilities } = await loadRuntimeStateModule();

  const capabilities = orchestratorInputCapabilities({
    composerHidden: false,
    composerDisabled: false,
    startingNewSession: false,
    wsStatus: 'open',
    runtimeHealth: 'spawning',
    latestRuntimeState: 'spawning',
  });

  assert.equal(capabilities.canAcceptChatInput, true);
  assert.equal(capabilities.canSubmitChatInput, true);
  assert.equal(capabilities.canAcceptTerminalInput, true);
  assert.equal(capabilities.canResizeTerminal, true);
  assert.equal(capabilities.canInterrupt, true);
  assert.equal(capabilities.stateLabel, 'spawning');
});

test('orchestrator terminal input is blocked for terminal or unavailable runtime states', async () => {
  const { orchestratorInputCapabilities } = await loadRuntimeStateModule();
  const base = {
    composerHidden: false,
    composerDisabled: false,
    startingNewSession: false,
    wsStatus: 'open' as const,
    latestRuntimeState: null,
  };

  for (const runtimeHealth of ['not_spawned', 'provider_missing', 'failed_resume', 'exited'] as const) {
    assert.equal(
      orchestratorInputCapabilities({ ...base, runtimeHealth }).canAcceptTerminalInput,
      false,
      runtimeHealth,
    );
  }
});

test('transient terminal input stays writable while session is spawning', async () => {
  const { transientInputCapabilities } = await loadRuntimeStateModule();

  const capabilities = transientInputCapabilities('spawning');

  assert.equal(capabilities.canAcceptChatInput, false);
  assert.equal(capabilities.canSubmitChatInput, false);
  assert.equal(capabilities.canAcceptTerminalInput, true);
  assert.equal(capabilities.canResizeTerminal, false);
  assert.equal(capabilities.canInterrupt, false);
  assert.equal(capabilities.stateLabel, 'spawning');
});

test('terminal input ack failures produce user-visible status text', async () => {
  const { latestTerminalInputFailure } = await loadRuntimeStateModule();

  assert.equal(
    latestTerminalInputFailure([
      {
        projectId: 'project-1',
        type: 'terminal-input-ack',
        ok: false,
        status: 'no-session',
        error: 'No live PTY is attached',
      },
    ])?.message,
    'No live PTY is attached',
  );

  assert.equal(
    latestTerminalInputFailure([
      {
        projectId: 'project-1',
        type: 'terminal-input-ack',
        ok: false,
        status: 'write-failed',
        error: '',
      },
    ])?.message,
    'PTY rejected raw input.',
  );

  assert.equal(
    latestTerminalInputFailure([
      { projectId: 'project-1', type: 'terminal-input-ack', ok: true },
    ]),
    null,
  );
});
