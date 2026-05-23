// path-guard.cjs — multi-mode CC hook for worktree binding + enforcement.
//
// Argv: node path-guard.cjs <mode>
//   gate-workflow — PreToolUse on Agent|Task: deny any Task call whose prompt
//                   doesn't carry the "[workflowRunId: ...]" token (i.e., not a
//                   workflow-runtime dispatch). Subagents are workflow-only
//                   (Section 3 D1); the orchestrator must route through
//                   pc_run_workflow. Runs BEFORE bind on the same matcher.
//   bind          — PreToolUse on Agent|Task: scan tool_input.prompt for the
//                   "[worktree: <abs-path>]" token; write a binding to
//                   <project-data-dir>/current-task-binding.json keyed by tool_use_id.
//   unbind        — PostToolUse on Agent|Task: drop that binding.
//   enforce       — PreToolUse on Read|Write|Edit|Bash|Glob|Grep|NotebookEdit:
//                   if the call is inside a subagent turn (payload.agent_type set)
//                   and the latest binding has a worktreePath, deny any tool call
//                   that touches paths outside the worktree. Exception:
//                   READ_ANYWHERE_PODS (currently `researcher`) can call
//                   Read/Glob/Grep against any path; edits stay bound.
//
// Bash enforcement is best-effort: a regex scan for absolute-looking paths in
// the command string. Not a true sandbox.

const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const BINDING_FILE = '{{PROJECT_DATA_DIR}}/current-task-binding.json';

const mode = process.argv[2] ?? '';
const raw = readStdinSync();
let payload = {};
try { payload = JSON.parse(raw); } catch { /* keep empty */ }

if (mode === 'gate-workflow') gateWorkflow();
else if (mode === 'bind') bind();
else if (mode === 'unbind') unbind();
else if (mode === 'enforce') enforce();
process.exit(0);

function readStdinSync() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

function readBindings() {
  try { return JSON.parse(readFileSync(BINDING_FILE, 'utf-8')); } catch { return {}; }
}

function writeBindings(b) {
  try {
    mkdirSync(dirname(BINDING_FILE), { recursive: true });
    writeFileSync(BINDING_FILE, JSON.stringify(b, null, 2));
  } catch { /* best-effort */ }
}

function norm(p) {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

function isInside(p, wt) {
  const pN = norm(p);
  const wtN = norm(wt);
  return pN === wtN || pN.startsWith(wtN + '/');
}

function extractWorktree(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/\[worktree:\s*([^\]]+)\]/);
  return m ? resolve(m[1].trim()) : null;
}

function gateWorkflow() {
  // PC product policy: subagents inside PC-spawned claude.exe are
  // workflow-only (Section 3 D1). The workflow runtime emits a dispatch
  // envelope containing "[workflowRunId: <id>]"; a Task() call without it
  // is a direct orchestrator dispatch and we deny it.
  //
  // BUT: the same `.claude/settings.json` loads in any claude.exe that
  // opens this repo — including the engineer running Claude Code as a dev
  // tool. PC's policy doesn't apply there; Task() should work normally.
  // Distinguish via PC_PROJECT_ID, which apps/server sets on every spawn
  // (orchestrator + dispatched agent). Absent = outer/dev session = skip.
  if (!process.env.PC_PROJECT_ID) return;

  const prompt = payload.tool_input && payload.tool_input.prompt;
  if (typeof prompt === 'string' && prompt.includes('[workflowRunId:')) return;
  const reason =
    'Direct Task() blocked. Subagents are workflow-only — author a workflow ' +
    'that dispatches the agent (via the conversational New Workflow modal), ' +
    'then call `pc_run_workflow` with its id.';
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
}

function bind() {
  const tu = payload.tool_use_id;
  const wt = extractWorktree(payload.tool_input && payload.tool_input.prompt);
  if (!tu || !wt) return;
  const all = readBindings();
  all[tu] = { worktreePath: wt, startedAt: new Date().toISOString() };
  writeBindings(all);
}

function unbind() {
  const tu = payload.tool_use_id;
  if (!tu) return;
  const all = readBindings();
  if (all[tu]) {
    delete all[tu];
    writeBindings(all);
  }
}

function enforce() {
  // Only enforce when CC tags the call as coming from inside a subagent.
  if (!payload.agent_type) return;
  const all = readBindings();
  const ids = Object.keys(all);
  if (!ids.length) return;
  // Sequential subagents in the rig → most-recently-written binding wins.
  const latest = all[ids[ids.length - 1]];
  const wt = latest && latest.worktreePath;
  if (!wt) return;

  const tool = payload.tool_name || '';

  // Pods with cross-worktree read permission: Read/Glob/Grep exempt from
  // worktree binding. Edit/Write/Bash/NotebookEdit stay bound. Add pod names
  // here as they earn the exemption.
  const READ_ANYWHERE_PODS = new Set(['researcher']);
  if (READ_ANYWHERE_PODS.has(payload.agent_type) && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) {
    return;
  }

  const inp = payload.tool_input || {};
  const violations = [];

  function checkPath(p) {
    if (!p || typeof p !== 'string') return;
    if (!isInside(p, wt)) violations.push(p);
  }

  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') checkPath(inp.file_path);
  if (tool === 'NotebookEdit') checkPath(inp.notebook_path);
  if ((tool === 'Glob' || tool === 'Grep') && inp.path) checkPath(inp.path);
  if (tool === 'Bash') {
    const cmd = String(inp.command || '');
    // Best-effort: scan for Windows-style absolute paths (drive letter prefix).
    // Try quoted forms first so Windows paths containing spaces aren't truncated
    // at the first whitespace. Order: single-quoted, double-quoted, backtick,
    // then bare/unquoted up to whitespace or shell delimiter.
    const re = /'([A-Za-z]:[\\/][^']+)'|"([A-Za-z]:[\\/][^"]+)"|`([A-Za-z]:[\\/][^`]+)`|([A-Za-z]:[\\/][^\s'"`)]+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      const path = m[1] || m[2] || m[3] || m[4];
      if (path && !isInside(path, wt)) violations.push(path);
    }
  }

  if (violations.length) {
    const reason =
      `Out-of-worktree call blocked. Bound worktree: ${wt}. ` +
      `Violating path(s): ${violations.join(', ')}`;
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
  }
}
