// Agent-host wiring constants.
//
// The host is OFF by default — flipping PC_AGENT_HOST=1 routes dispatched
// agents through the out-of-process host. Until phase-2 reattach + phase-3
// ownership land, this stays opt-in so the in-process path is the safe default.

/** Master switch. When falsy, dispatches use the in-process LowLevelSpawn. */
export function isAgentHostEnabled(): boolean {
  return process.env.PC_AGENT_HOST === '1';
}

/** Control-channel port. Adjacent to the existing channel ports
 *  (dev 8788 / dogfood 8798) — default 8790, override via PC_AGENT_HOST_PORT. */
export function agentHostPort(): number {
  return Number(process.env.PC_AGENT_HOST_PORT ?? 8790);
}
