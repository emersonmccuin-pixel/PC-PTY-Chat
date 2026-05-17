// Generic hook script. Wired for UserPromptSubmit, PreToolUse, PostToolUse, Stop.
// Reads the hook JSON payload from stdin, optionally extracts the latest
// assistant message from the session transcript on Stop, and appends a
// normalized event to <session-dir>/events.jsonl.
//
// Path resolution: PC sets PC_SESSION_ID in the claude.exe spawn env. When
// set, all per-session files land under <project-data-dir>/sessions/<id>/.
// When unset (legacy / hand-invoke / first-run before plumbing), we fall
// back to the project-wide path so the hook still works.
//
// Argv: node event-capture.cjs <eventType>
//   <eventType> = UserPromptSubmit | PreToolUse | PostToolUse | Stop

const { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
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
  case 'UserPromptSubmit': {
    const text = typeof payload.prompt === 'string' ? payload.prompt : '';
    appendEvent({ ts: now, kind: 'user', text });
    break;
  }
  case 'PreToolUse': {
    // Agent (a.k.a. Task in SDK) = orchestrator delegating to a subagent.
    // Render through a dedicated bubble instead of the generic tool-start.
    if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
      appendEvent({
        ts: now,
        kind: 'task-start',
        subagent: payload.tool_input?.subagent_type ?? 'unknown',
        description: payload.tool_input?.description ?? '',
        prompt: payload.tool_input?.prompt ?? '',
      });
      break;
    }
    // Tool calls made *inside* a subagent's turn carry payload.agent_type.
    // Skip emission so the researcher works silently — BUILDOUT Slice 1 contract.
    if (payload.agent_type) break;
    appendEvent({
      ts: now,
      kind: 'tool-start',
      tool: payload.tool_name ?? 'unknown',
      input: payload.tool_input ?? null,
    });
    break;
  }
  case 'PostToolUse': {
    // TodoWrite (legacy bulk): capture the full todos list directly.
    if (payload.tool_name === 'TodoWrite' && Array.isArray(payload.tool_input?.todos)) {
      appendEvent({ ts: now, kind: 'todos', todos: payload.tool_input.todos });
      break;
    }
    // TaskCreate / TaskUpdate (newer per-task tools): accumulate state in
    // tasks.json, then emit the full current snapshot so the UI panel can
    // re-render. Other Task* tools are read-only and don't change state.
    if (payload.tool_name === 'TaskCreate' || payload.tool_name === 'TaskUpdate') {
      const todos = applyTaskChange(payload.tool_name, payload.tool_input, payload.tool_response);
      if (todos) appendEvent({ ts: now, kind: 'todos', todos });
      break;
    }
    // Agent (a.k.a. Task) subagent return — normalize tool_response to readable text.
    if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') {
      appendEvent({
        ts: now,
        kind: 'task-end',
        subagent: payload.tool_input?.subagent_type ?? 'unknown',
        result: truncate(extractTaskResultText(payload.tool_response), 4000),
      });
      break;
    }
    // Suppress tool-end for calls made inside a subagent (see PreToolUse note).
    if (payload.agent_type) break;
    appendEvent({
      ts: now,
      kind: 'tool-end',
      tool: payload.tool_name ?? 'unknown',
      result: truncate(payload.tool_response, 1000),
    });
    break;
  }
  case 'Stop': {
    // Stop hook payload contains `last_assistant_message` directly — use it.
    // Fall back to transcript-JSONL extraction only if the field is missing.
    let text = typeof payload.last_assistant_message === 'string'
      ? payload.last_assistant_message
      : '';
    const transcriptPath = payload.transcript_path;
    if (!text && transcriptPath && existsSync(transcriptPath)) {
      text = extractLastAssistantText(transcriptPath);
    }
    appendEvent({ ts: now, kind: 'assistant', text, transcriptPath: transcriptPath ?? null });
    // Keep the legacy turn-end marker for the existing watcher path.
    try {
      mkdirSync(dirname(STOP_MARKER), { recursive: true });
      appendFileSync(STOP_MARKER, now + '\n');
    } catch { /* swallow */ }
    break;
  }
  case 'SubagentStop': {
    // Section 0 phase 0e — supplemental signal. Section 2 (Subagents) decides
    // how to render. For now, capture the data so the activity panel + future
    // subagent UX has the history.
    appendEvent({
      ts: now,
      kind: 'subagent-stop',
      subagent: payload.subagent_type ?? payload.agent_type ?? null,
      result: typeof payload.last_assistant_message === 'string'
        ? truncate(payload.last_assistant_message, 4000)
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
  case 'Notification': {
    // CC's own notification surface — agent waiting on input, idle timeout,
    // etc. Render as a small system-message row in the chat.
    appendEvent({
      ts: now,
      kind: 'notification',
      message: typeof payload.message === 'string' ? payload.message : '',
      title: typeof payload.title === 'string' ? payload.title : null,
    });
    break;
  }
  default:
    appendEvent({ ts: now, kind: 'unknown-event', eventType, payload });
}

process.exit(0);

function extractLastAssistantText(path) {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      if (obj.type !== 'assistant') continue;
      const content = obj?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
      if (text) return text;
    }
  } catch {
    /* fall through */
  }
  return '';
}

function truncate(value, max) {
  if (value == null) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

// Task tool_response shape varies: usually `content: [{type:'text', text}]`
// (the subagent's final message), sometimes plain string, sometimes raw object.
function extractTaskResultText(response) {
  if (response == null) return '';
  if (typeof response === 'string') return response;
  const content = response.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (text) return text;
  }
  return JSON.stringify(response);
}

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
