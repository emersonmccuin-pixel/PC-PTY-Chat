// WS adapter for the agent-host control channel.
//
// Wraps a `ws` socket as the runtime's transport-agnostic MessageChannel. Both
// ends share one impl; the type parameters flip per side:
//   - host side  : MessageChannel<HostToServerMsg, ServerToHostMsg>
//   - client side: MessageChannel<ServerToHostMsg, HostToServerMsg>
// A malformed frame is logged + dropped, never fatal to the connection.

import type { WebSocket } from 'ws';

import {
  decodeMsg,
  encodeMsg,
  type HostToServerMsg,
  type MessageChannel,
  type ServerToHostMsg,
} from '@pc/runtime';

type AnyMsg = ServerToHostMsg | HostToServerMsg;

function wsChannel<TX extends AnyMsg, RX extends AnyMsg>(
  ws: WebSocket,
): MessageChannel<TX, RX> {
  return {
    send: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeMsg(msg));
    },
    subscribe: (handler) => {
      const onMsg = (data: unknown): void => {
        let parsed: RX;
        try {
          parsed = decodeMsg<RX>(String(data));
        } catch (err) {
          console.error(
            `[agent-host] dropped malformed frame: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        handler(parsed);
      };
      ws.on('message', onMsg);
      return () => ws.off('message', onMsg);
    },
  };
}

/** Host process side — sends HostToServerMsg, receives ServerToHostMsg. */
export function hostSideChannel(
  ws: WebSocket,
): MessageChannel<HostToServerMsg, ServerToHostMsg> {
  return wsChannel<HostToServerMsg, ServerToHostMsg>(ws);
}

/** API-server (client) side — sends ServerToHostMsg, receives HostToServerMsg. */
export function clientSideChannel(
  ws: WebSocket,
): MessageChannel<ServerToHostMsg, HostToServerMsg> {
  return wsChannel<ServerToHostMsg, HostToServerMsg>(ws);
}
