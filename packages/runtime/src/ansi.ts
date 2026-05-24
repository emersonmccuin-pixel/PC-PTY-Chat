// ANSI normalization for substring detection on raw PTY output.
//
// CC paints the composer in two different ways depending on path:
//   fresh : "/remote-control is active · Continue here..."  (contiguous spaces)
//   resume: "/remote-control\x1b[1Cis\x1b[1Cactive\x1b[1C..." (cursor-move-right
//                                                              between every word)
//
// A naive `stripAnsi(buf).includes(probe)` matches the fresh case but not the
// resume case — `\x1b[1C` strips to empty, gluing adjacent words. Map
// cursor-move-right sequences to spaces FIRST, then strip the rest, then
// collapse whitespace runs. The labs `pty-driver.mjs:collapseWhitespace`
// validated this approach across 45+ runs.

export function collapseAnsiToWhitespace(s: string): string {
  return (
    s
      // CSI N C  →  one space. Catches the resume-painting case.
      .replace(/\x1b\[\d*C/g, ' ')
      // Strip remaining CSI sequences.
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      // Strip OSC sequences (window titles etc).
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Strip the simple two-byte ESC-set commands.
      .replace(/\x1b[>=()]/g, '')
      // Collapse all whitespace runs to a single space.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Strip ANSI/CSI but preserve visual spacing — cursor-forward becomes N
 *  spaces. Used by chunk listeners that need readable text without losing
 *  layout. The gate uses collapseAnsiToWhitespace instead. */
export function stripAnsiPreserveSpacing(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[>=()]/g, '');
}
