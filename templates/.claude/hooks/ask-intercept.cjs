// PreToolUse hook for interactive tools (AskUserQuestion, ExitPlanMode).
// Forwards the tool input to the PC server (with this project's id), waits for
// the user's answer, then denies the original tool call with the answer as the
// reason — so CC sees the answer and continues.

const { readFileSync } = require('node:fs');
const { request } = require('node:http');

const PROJECT_ID = '{{PROJECT_ID}}';
const SERVER_PORT = Number('{{PC_SERVER_PORT}}') || 4040;

const raw = readSync(0);
let payload = {};
try { payload = JSON.parse(raw); } catch { /* keep empty */ }

const toolName = payload.tool_name ?? 'Unknown';
const toolUseId = payload.tool_use_id ?? `na-${Date.now()}`;
const toolInput = payload.tool_input ?? {};
// PC_SESSION_ID is set on every claude.exe spawn (orchestrator + agent-creator
// + workflow-creator). Forwarding it lets the UI filter ask envelopes to the
// session that asked — so a transient modal doesn't intercept the
// orchestrator's asks (and vice versa).
const sessionId = process.env.PC_SESSION_ID || null;

// Hard kill: plan mode is disabled in PC. Auto-deny both entry and exit
// so CC never enters the review-and-approve loop.
if (toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode') {
  emitDenyAndExit('Plan mode is disabled here — proceed directly with the work, no plan-then-approve loop.');
}

const body = JSON.stringify({ projectId: PROJECT_ID, sessionId, toolName, toolUseId, toolInput });

const req = request(
  {
    host: '127.0.0.1',
    port: SERVER_PORT,
    path: '/api/ask',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks).toString('utf-8');
      let answer = '(no answer)';
      try {
        const parsed = JSON.parse(buf);
        if (parsed && typeof parsed.answer === 'string') answer = parsed.answer;
      } catch {
        /* keep default */
      }
      if (answer === '__cancelled__') {
        emitDeny(`User declined to answer (${toolName}). Choose a different approach or ask differently.`);
      } else {
        emitDeny(`User answered (${toolName}): ${answer}`);
      }
    });
  },
);

req.setTimeout(10 * 60 * 1000, () => {
  req.destroy(new Error('timeout'));
  emitDeny(`Ask intercept timed out waiting for user (${toolName}).`);
});

req.on('error', (err) => {
  emitDeny(`Ask intercept failed (${toolName}): ${err.message}`);
});

req.write(body);
req.end();

function emitDeny(reason) {
  // Use both old + new hook decision schemas — CC accepts whichever it knows.
  const out = {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function emitDenyAndExit(reason) {
  emitDeny(reason);
}

function readSync(fd) {
  // readFileSync(0) is the standard pattern for reading stdin synchronously
  // from a short-lived hook script. It blocks until EOF.
  try {
    return readFileSync(fd, 'utf-8');
  } catch {
    return '';
  }
}
