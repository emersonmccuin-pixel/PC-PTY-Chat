// Bracketed-paste + echo-ack send.
//
// Production today uses a 500ms setTimeout between paste and `\r`
// (pty-session.ts:517, labeled "conservative"). The rebuild replaces this
// with the positive ack — the labs anti-criteria (D7) prohibits timing-
// heuristic gates and the labs scenarios proved echo-ack reliable across
// 45+ runs.
//
// Send sequence:
//   1. Write `\x1b[200~<body>\x1b[201~` to the PTY.
//   2. Poll raw stdout buffer for an ANSI-normalized substring of the body.
//      CC echoes the first 12 characters of the paste into the composer
//      within 5–50ms. The substring is normalized so the resume-mode
//      cursor-move-right painting also matches (see ansi.ts).
//   3. After echo lands, write `\r`.
//
// The 5s ceiling is defense — if the echo never lands the spawn is in a bad
// state that needs to be reported as a failure, not silently retried.

import { collapseAnsiToWhitespace } from './ansi.ts';

export type SendResult = 'ok' | 'echo-timeout' | 'exited';

export interface SendDeps {
  /** Write raw bytes to the PTY. */
  write: (bytes: string) => void;
  /** Return the current raw output buffer accumulated by the spawn. */
  getRawBuffer: () => string;
  /** Returns true if the PTY has exited. */
  isExited: () => boolean;
  /** Optional clock override for tests. */
  now?: () => number;
  /** Optional sleep override for tests. Default is setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const ECHO_TIMEOUT_MS_DEFAULT = 5000;
const ECHO_POLL_MS = 25;
/** First N chars of body used to build the echo-detection probe. CC normalizes
 *  pasted input in the composer; matching on the leading slice maximizes the
 *  hit rate while staying short enough to avoid spuriously matching pre-paste
 *  prompt content. */
const ECHO_PROBE_LEN = 12;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send a body through the bracketed-paste + echo-ack protocol. */
export async function sendBracketedPaste(
  deps: SendDeps,
  body: string,
  timeoutMs: number = ECHO_TIMEOUT_MS_DEFAULT,
): Promise<SendResult> {
  if (deps.isExited()) return 'exited';

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const probe = collapseAnsiToWhitespace(body.slice(0, ECHO_PROBE_LEN));
  const markBefore = deps.getRawBuffer().length;

  deps.write(`\x1b[200~${body}\x1b[201~`);

  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (deps.isExited()) return 'exited';
    const tail = deps.getRawBuffer().slice(markBefore);
    if (probe.length === 0 || collapseAnsiToWhitespace(tail).includes(probe)) {
      deps.write('\r');
      return 'ok';
    }
    await sleep(ECHO_POLL_MS);
  }
  return 'echo-timeout';
}
