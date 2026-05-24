// Generic hook script. Wired for UserPromptSubmit, PreToolUse, PostToolUse, Stop.
// Reads the hook JSON payload from stdin, optionally extracts the latest
// assistant message from the session transcript on Stop, and appends a
// normalized event to <session-dir>/events.jsonl.
//
// Identity guard: PC sets PC_SESSION_ID in the claude.exe spawn env on every
// orchestrator + transient-session spawn. If it's UNSET we're a caller PC
// didn't spawn — an outer Claude Code dev session running in the repo, or a
// hand-invoke. Same identity-bleed class as Section 15's JSONL fix: only
// attach to/write into what matches the session we own. Bail out silently
// so the outer caller's events don't land in the live orchestrator chat.
//
// Argv: node event-capture.cjs <eventType>
//   <eventType> = UserPromptSubmit | PreToolUse | PostToolUse | Stop

if (!process.env.PC_SESSION_ID) process.exit(0);

const { appendFileSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const PROJECT_DATA_DIR = '{{PROJECT_DATA_DIR}}';
const SESSION_ID = process.env.PC_SESSION_ID || '';
const DATA_DIR = SESSION_ID ? PROJECT_DATA_DIR + '/sessions/' + SESSION_ID : PROJECT_DATA_DIR;

const EVENTS_FILE = DATA_DIR + '/events.jsonl';
const STOP_MARKER = DATA_DIR + '/stop-markers.txt';
const DEBUG_FILE  = DATA_DIR + '/hook-debug.jsonl';
const TASKS_FILE  = DATA_DIR + '/tasks.json';

const eventType = process.argv[2] ?? 'Unknown';

function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function appendEvent(obj) {
  try {
    mkdirSync(dirname(EVENTS_FILE), { recursive: true });
    appendFileSync(EVENTS_FILE, JSON.stringify(obj) + '\n');
  } catch {
    /* never block the turn */
  }
}

function debug(obj) {
  try {
    mkdirSync(dirname(DEBUG_FILE), { recursive: true });
    appendFileSync(DEBUG_FILE, JSON.stringify(obj) + '\n');
  } catch {
    /* swallow */
  }
}

const raw = readStdinSync();
let payload = {};
try { payload = JSON.parse(raw); } catch { /* keep empty */ }

const now = new Date().toISOString();
debug({ ts: now, eventType, payload });

switch (eventType) {
  case 'UserPromptSubmit':
    // Section 23.4 — user prompts now flow through JSONL exclusively. CC
    // writes a `type:'user'` row for every prompt; the tailer emits
    // jsonl-user; the chat panel renders from there. Hook keeps the
    // debug-line write above (for hook-debug.jsonl audit) but no longer
    // emits chat content.
    break;
  case 'PreToolUse':
    // Section 23.4 — tool-call starts now flow through JSONL exclusively.
    // CC writes a `tool_use` content block on the assistant message; the
    // tailer emits jsonl-tool-call; the chat panel renders from there.
    // Including the Agent/Task dispatch: the JSONL row carries name +
    // input (subagent_type / description / prompt) — the chat panel can
    // synthesize the dedicated task-start bubble from that data.
    break;
  case 'PostToolUse': {
    // Section 23.4 — generic tool-end + Agent/Task task-end now flow
    // through JSONL exclusively (jsonl-tool-result). Todos still live in
    // a hook-accumulated snapshot until Section 23.5 migrates them
    // client-side.
    if (payload.tool_name === 'TodoWrite' && Array.isArray(payload.tool_input?.todos)) {
      appendEvent({ ts: now, kind: 'todos', todos: payload.tool_input.todos });
      break;
    }
    if (payload.tool_name === 'TaskCreate' || payload.tool_name === 'TaskUpdate') {
      const todos = applyTaskChange(payload.tool_name, payload.tool_input, payload.tool_response);
      if (todos) appendEvent({ ts: now, kind: 'todos', todos });
      break;
    }
    break;
  }
  case 'Stop': {
    // Section 23.4 — the assistant turn-end now flows through JSONL
    // exclusively (jsonl-turn-end on the assistant row whose stop_reason
    // is end_turn or one of the documented Stop-skip cases). Hook only
    // keeps the legacy stop-marker append for the workflow runtime's
    // turn-end watcher (separate consumer from chat content).
    try {
      mkdirSync(dirname(STOP_MARKER), { recursive: true });
      appendFileSync(STOP_MARKER, now + '\n');
    } catch { /* swallow */ }
    break;
  }
  case 'SubagentStop': {
    // Section 0 phase 0e captured this as supplemental signal. Section 3 3g
    // promotes transcriptPath into the event so the workflow runtime can
    // correlate failures with the per-run JSONL CC wrote.
    appendEvent({
      ts: now,
      kind: 'subagent-stop',
      subagent: payload.subagent_type ?? payload.agent_type ?? null,
      result: typeof payload.last_assistant_message === 'string'
        ? truncate(payload.last_assistant_message, 4000)
        : null,
      transcriptPath: typeof payload.transcript_path === 'string'
        ? payload.transcript_path
        : null,
    });
    break;
  }
  case 'SessionEnd': {
    // Composer disables on this in the chat panel — CC's session is gone.
    appendEvent({
      ts: now,
      kind: 'session-end',
      reason: typeof payload.reason === 'string' ? payload.reason : null,
    });
    break;
  }
  case 'StopFailure': {
    // Phase 0c-followup case 1 — CC fires this when the assistant turn ends
    // via an API error (rate limit, prompt-too-long, auth failure, etc.;
    // see CC src/query.ts:1263). No assistant content lands in the JSONL,
    // so the chat panel's `isThinking` would otherwise hang. Emit a
    // synthetic turn-end so the indicator clears.
    const text = typeof payload.last_assistant_message === 'string'
      ? payload.last_assistant_message
      : '';
    const error = typeof payload.error === 'string' ? payload.error : 'unknown';
    appendEvent({
      ts: now,
      kind: 'stop-failure',
      text,
      error,
      errorDetails: payload.error_details ?? null,
    });
    break;
  }
  default:
    appendEvent({ ts: now, kind: 'unknown-event', eventType, payload });
}

process.exit(0);

function loadTaskState() {
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveTaskState(state) {
  try {
    mkdirSync(dirname(TASKS_FILE), { recursive: true });
    writeFileSync(TASKS_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* swallow */
  }
}

// Apply a TaskCreate or TaskUpdate to the persistent task state.
// Returns the resulting todos array (sorted by numeric id), or null if no change.
function applyTaskChange(toolName, input, response) {
  const state = loadTaskState();

  if (toolName === 'TaskCreate') {
    const id = response?.task?.id ?? input?.id;
    if (!id) return null;
    state[id] = {
      id: String(id),
      subject: input?.subject ?? '',
      description: input?.description ?? '',
      activeForm: input?.activeForm ?? '',
      status: 'pending',
    };
  } else if (toolName === 'TaskUpdate') {
    const id = input?.taskId;
    if (!id) return null;
    const existing = state[id] || { id: String(id), subject: '', description: '', activeForm: '', status: 'pending' };
    state[id] = {
      ...existing,
      subject: input?.subject ?? existing.subject,
      description: input?.description ?? existing.description,
      activeForm: input?.activeForm ?? existing.activeForm,
      status: input?.status ?? existing.status,
    };
  } else {
    return null;
  }

  saveTaskState(state);

  return Object.values(state)
    .sort((a, b) => {
      const an = Number(a.id), bn = Number(b.id);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return String(a.id).localeCompare(String(b.id));
    })
    .map((t) => ({
      content: t.subject,
      activeForm: t.activeForm,
      status: t.status,
    }));
}
