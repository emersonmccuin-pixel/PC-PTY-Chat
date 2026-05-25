// Section 31.7 — statusline-command bridge.
//
// CC's settings.statusLine.command runs this script on every status-line
// refresh (debounced inside CC; typically 1×/turn). PC consumes it for the
// rate-limit / model / cost / context-window data CC parses from response
// headers but never writes to JSONL.
//
// Contract:
//   - stdin: the StatusLineCommandInput JSON (see CC src/components/StatusLine.tsx)
//   - stdout: status-line text to paint into CC's TUI footer. PC's chat panel
//     hides this surface, so we emit nothing — empty stdout is fine per CC's
//     handler (it only uses output when truthy).
//   - side-effect: fire-and-forget POST to /api/internal/statusline-data
//     with the extracted fields, keyed by PC_SESSION_ID.
//
// Identity guard: same pattern as inbox-drain.cjs — without PC_SESSION_ID
// we're some outer Claude Code (not a PC-spawned session); exit silently.

const http = require('node:http');

const PROJECT_ID = '{{PROJECT_ID}}';
const SERVER_PORT = Number(process.env.PC_SERVER_PORT || 4040);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
    // 2s safety in case stdin never closes (shouldn't happen with CC, but
    // be defensive — this script must NEVER stall the statusline path).
    setTimeout(() => resolve(''), 2_000);
  });
}

function extractSnapshot(input, pcSessionId) {
  const fiveHour = input.rate_limits && input.rate_limits.five_hour;
  const sevenDay = input.rate_limits && input.rate_limits.seven_day;
  return {
    projectId: PROJECT_ID,
    pcSessionId,
    ccSessionId: typeof input.session_id === 'string' ? input.session_id : '',
    receivedAt: Date.now(),
    model: input.model
      ? { id: input.model.id || '', displayName: input.model.display_name || input.model.id || '' }
      : null,
    rateLimits: {
      fiveHour: fiveHour
        ? {
            usedPercentage: Number(fiveHour.used_percentage) || 0,
            resetsAt: String(fiveHour.resets_at || ''),
          }
        : null,
      sevenDay: sevenDay
        ? {
            usedPercentage: Number(sevenDay.used_percentage) || 0,
            resetsAt: String(sevenDay.resets_at || ''),
          }
        : null,
    },
    cost: input.cost
      ? {
          totalCostUsd: Number(input.cost.total_cost_usd) || 0,
          totalDurationMs: Number(input.cost.total_duration_ms) || 0,
          totalApiDurationMs: Number(input.cost.total_api_duration_ms) || 0,
        }
      : null,
    contextWindow: input.context_window
      ? {
          currentUsage: Number(input.context_window.current_usage) || 0,
          contextWindowSize: Number(input.context_window.context_window_size) || 0,
          usedPercentage: Number(input.context_window.used_percentage) || 0,
          totalInputTokens: Number(input.context_window.total_input_tokens) || 0,
          totalOutputTokens: Number(input.context_window.total_output_tokens) || 0,
        }
      : null,
  };
}

function postSnapshot(snapshot) {
  return new Promise((resolve) => {
    const body = JSON.stringify(snapshot);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: SERVER_PORT,
        method: 'POST',
        path: '/api/internal/statusline-data',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 1_500,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

async function main() {
  const pcSessionId = process.env.PC_SESSION_ID;
  if (!pcSessionId || !PROJECT_ID) {
    process.exit(0);
  }
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  try {
    await postSnapshot(extractSnapshot(input, pcSessionId));
  } catch {
    /* best-effort */
  }
  // No stdout — CC's footer treats empty as "use built-in".
  process.exit(0);
}

module.exports = { extractSnapshot };
if (require.main === module) main();
