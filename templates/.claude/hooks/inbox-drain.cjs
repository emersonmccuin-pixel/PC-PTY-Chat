// Section 18.4 — UserPromptSubmit hook: drain pending agent_inbox rows for
// this orchestrator's session, mark them delivered with driver='user-prompt',
// and prepend their payloads as `<channel source="agent" ...>` blocks via
// the standard `additionalContext` hook output.
//
// This is the second of two paths a pending inbox row exits via:
//   1. Auto-flush on bridge registration / live channel push (18.3) →
//      driver='autonomous'.
//   2. UserPromptSubmit hook drain (this script) → driver='user-prompt'.
//
// Both paths are atomic via the same `UPDATE ... WHERE status='pending'`
// guard, so racing autonomous and hook drains can't double-deliver.
//
// Identity guard: PC sets PC_SESSION_ID on every spawn. Without it we're
// some outer Claude Code instance — same identity-bleed class as Section
// 15's JSONL fix. main() exits silently in that case; the identity guard
// MUST live inside main(), not at module-load time, because the unit-test
// suite imports this file via require() with PC_SESSION_ID unset.

const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join } = require('node:path');

const PC_TRUNK_PATH = '{{PC_TRUNK_PATH}}';
const PC_DB_PATH = '{{PC_DB_PATH}}';
const PROJECT_SLUG = '{{PROJECT_SLUG}}';

function drainInbox(opts) {
  const { dbPath, trunkPath, sessionId, now } = opts;

  // Emergency kill switch. Same env flag the server-side 18.3 emit reads.
  // `channel-only` mode means inbox writes never happened, so there's
  // nothing to drain.
  const transport = (process.env.PC_DELIVERY_TRANSPORT || 'hybrid').toLowerCase();
  if (transport === 'channel-only') return { rows: [], drained: 0 };

  if (!dbPath || !existsSync(dbPath)) return { rows: [], drained: 0 };

  // Resolve better-sqlite3 via packages/db's pnpm-managed node_modules.
  // The hook script lives in the project worktree, where better-sqlite3
  // isn't installed; createRequire anchored on packages/db/package.json
  // walks the workspace dep graph from there. (Trunk-root anchor fails
  // because trunk's package.json doesn't declare better-sqlite3 as a
  // direct dep; @pc/db does.)
  let Database;
  try {
    const dbPkgRequire = createRequire(join(trunkPath, 'packages/db/package.json'));
    Database = dbPkgRequire('better-sqlite3');
  } catch {
    // Native binding missing or trunk path wrong — fail silent (drain skipped,
    // event delivery still works via the channel push or the next prompt).
    return { rows: [], drained: 0 };
  }

  const db = new Database(dbPath, { readonly: false, fileMustExist: true });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const pending = db
      .prepare(
        'SELECT id, event_kind, payload_body FROM agent_inbox ' +
          'WHERE recipient_session_id = ? AND status = ? ORDER BY created_at ASC',
      )
      .all(sessionId, 'pending');

    if (pending.length === 0) return { rows: [], drained: 0 };

    const flipStmt = db.prepare(
      'UPDATE agent_inbox SET status = ?, delivered_at = ? WHERE id = ? AND status = ?',
    );
    const auditStmt = db.prepare(
      'UPDATE agent_delivery_audit SET driver = ?, hook_drained_at = ? WHERE inbox_id = ?',
    );

    const drained = [];
    for (const row of pending) {
      const tx = db.transaction(() => {
        const r = flipStmt.run('delivered', now, row.id, 'pending');
        if (r.changes === 0) return false;
        auditStmt.run('user-prompt', now, row.id);
        return true;
      });
      if (tx()) {
        drained.push({ id: row.id, eventKind: row.event_kind, payloadBody: row.payload_body });
      }
    }
    return { rows: drained, drained: drained.length };
  } finally {
    db.close();
  }
}

function renderPreamble(rows, slug) {
  if (rows.length === 0) return '';
  const path = `/channel/${slug}/agent`;
  const wrapped = rows
    .map(
      (r) =>
        `<channel source="agent" path="${path}" method="POST">\n${r.payloadBody}\n</channel>`,
    )
    .join('\n\n');
  const intro =
    rows.length === 1
      ? `One agent event arrived while you were idle. Process it per the agent-event handler protocol before responding to the user's prompt below.`
      : `${rows.length} agent events arrived while you were idle. Process them per the agent-event handler protocol (oldest first) before responding to the user's prompt below.`;
  return `${intro}\n\n${wrapped}`;
}

// Entry point. Called by CC's hook runner; the script exits 0 either way and
// optionally writes an `additionalContext` JSON envelope on stdout.
function main() {
  const sessionId = process.env.PC_SESSION_ID;
  if (!sessionId) {
    process.exit(0);
  }
  let result;
  try {
    result = drainInbox({
      dbPath: PC_DB_PATH,
      trunkPath: PC_TRUNK_PATH,
      sessionId,
      now: Date.now(),
    });
  } catch {
    // Drain itself failed — exit silently. The event delivery isn't lost;
    // the row stays pending and the next prompt picks it up.
    process.exit(0);
  }
  if (result.drained === 0) {
    process.exit(0);
  }
  const additionalContext = renderPreamble(result.rows, PROJECT_SLUG);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }),
  );
  process.exit(0);
}

// Export for unit testing; only run main() when executed directly.
module.exports = { drainInbox, renderPreamble };
if (require.main === module) main();
