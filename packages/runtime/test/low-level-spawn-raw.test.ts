import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { LowLevelSpawn, type LowLevelSpawnInput, type SpawnState } from '../src/low-level-spawn.ts';

class FakePty extends EventEmitter {
  writes: string[] = [];
  killed = false;
  write(bytes: string): void {
    this.writes.push(bytes);
  }
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
}

function input(): LowLevelSpawnInput {
  return {
    podDefinition: { name: 'orchestrator' },
    worktreePath: 'C:\\fake\\project',
    env: {},
    ccProviderSessionId: '00000000-0000-0000-0000-000000000001',
    mode: 'fresh',
  };
}

function setChild(spawn: LowLevelSpawn, child: FakePty, state: SpawnState): void {
  const internals = spawn as unknown as { child: FakePty; state: SpawnState };
  internals.child = child;
  internals.state = state;
}

test('writeRaw() forwards exact bytes to the PTY child', () => {
  const spawn = new LowLevelSpawn(input());
  const child = new FakePty();
  setChild(spawn, child, 'ready');

  assert.equal(spawn.writeRaw('/help\r'), true);
  assert.equal(spawn.writeRaw('\x1b[A\x03'), true);
  assert.deepEqual(child.writes, ['/help\r', '\x1b[A\x03']);
});

test('writeRaw() before spawn or after exit returns false', () => {
  const spawn = new LowLevelSpawn(input());
  assert.equal(spawn.writeRaw('before'), false);

  const child = new FakePty();
  setChild(spawn, child, 'exited');
  assert.equal(spawn.writeRaw('after'), false);
  assert.deepEqual(child.writes, []);
});

test('writeRaw() Ctrl-C is not rewritten into the graceful kill path', () => {
  const spawn = new LowLevelSpawn(input());
  const child = new FakePty();
  setChild(spawn, child, 'running');

  assert.equal(spawn.writeRaw('\x03'), true);
  assert.deepEqual(child.writes, ['\x03']);
  assert.equal(child.killed, false);
});
