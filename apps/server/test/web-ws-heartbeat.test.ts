import assert from 'node:assert/strict';
import { test } from 'node:test';

type WsHeartbeatModule = {
  RECONNECT_SCHEDULE_MS: readonly number[];
  WS_HEARTBEAT_TIMEOUT_MS: number;
  createHeartbeatPing: (now?: number, random?: () => number) => {
    type: 'client-ping';
    nonce: string;
    sentAt: number;
  };
  heartbeatTimedOut: (lastInboundAt: number, now?: number, timeoutMs?: number) => boolean;
  nextBackoffMs: (prevDelay: number) => number;
};

async function loadHeartbeatModule(): Promise<WsHeartbeatModule> {
  const moduleUrl = new URL('../../web/src/hooks/ws-heartbeat.ts', import.meta.url).href;
  return (await import(moduleUrl)) as WsHeartbeatModule;
}

test('websocket reconnect backoff advances through the capped schedule', async () => {
  const { RECONNECT_SCHEDULE_MS, nextBackoffMs } = await loadHeartbeatModule();

  assert.deepEqual(RECONNECT_SCHEDULE_MS, [2_000, 5_000, 15_000, 30_000]);
  assert.equal(nextBackoffMs(2_000), 5_000);
  assert.equal(nextBackoffMs(5_000), 15_000);
  assert.equal(nextBackoffMs(15_000), 30_000);
  assert.equal(nextBackoffMs(30_000), 30_000);
  assert.equal(nextBackoffMs(123), 30_000);
});

test('websocket heartbeat timeout trips only at the configured threshold', async () => {
  const { WS_HEARTBEAT_TIMEOUT_MS, heartbeatTimedOut } = await loadHeartbeatModule();
  const lastInboundAt = 1_000;

  assert.equal(
    heartbeatTimedOut(lastInboundAt, lastInboundAt + WS_HEARTBEAT_TIMEOUT_MS - 1),
    false,
  );
  assert.equal(
    heartbeatTimedOut(lastInboundAt, lastInboundAt + WS_HEARTBEAT_TIMEOUT_MS),
    true,
  );
  assert.equal(heartbeatTimedOut(lastInboundAt, lastInboundAt + 499, 500), false);
  assert.equal(heartbeatTimedOut(lastInboundAt, lastInboundAt + 500, 500), true);
});

test('websocket heartbeat ping carries a client nonce and send timestamp', async () => {
  const { createHeartbeatPing } = await loadHeartbeatModule();

  assert.deepEqual(createHeartbeatPing(42_000, () => 0.5), {
    type: 'client-ping',
    nonce: '42000-i',
    sentAt: 42_000,
  });
});
