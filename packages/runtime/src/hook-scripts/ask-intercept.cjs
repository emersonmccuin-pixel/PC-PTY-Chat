// PreToolUse hook for interactive tools (AskUserQuestion, ExitPlanMode).
// Forwards the tool input to the PC-PTY-Chat server, waits for the user's
// answer, then denies the original tool call with the answer as the reason
// — so CC sees the answer and continues.

const { readFileSync } = require('node:fs');
const { request } = require('node:http');

const raw = readSync(0);
let payload = {};
try { payload = JSON.parse(raw); } catch { /* keep empty */ }

const toolName = payload.tool_name ?? 'Unknown';
const toolUseId = payload.tool_use_id ?? `na-${Date.now()}`;
const toolInput = payload.tool_input ?? {};

// Hard kill: plan mode is disabled in PC. Auto-deny both entry and exit
// so CC never enters the review-and-approve loop.
if (toolName === 'ExitPlanMode' || toolName === 'EnterPlanMode') {
  emitDenyAndExit('Plan mode is disabled here — proceed directly with the work, no plan-then-approve loop.');
}

const body = JSON.stringify({ toolName, toolUseId, toolInput });

const req = request(
  {
    host: '127.0.0.1',
    port: 4040,
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
      emitDeny(`User answered (${toolName}): ${answer}`);
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
