/* global Terminal, FitAddon, marked */

if (typeof marked !== 'undefined') {
  // gfm tables + strikethrough; do NOT enable breaks (would insert <br> on every
  // newline and clash with normal paragraph rules).
  marked.setOptions({ gfm: true, breaks: false });
}

function renderMarkdown(text) {
  if (typeof marked === 'undefined' || !text) return text;
  try {
    let html = marked.parse(text);
    // Wrap each <table> in a scrollable container so wide tables can scroll
    // horizontally inside the bubble instead of breaking the bubble width.
    html = html
      .replace(/<table([\s>])/g, '<div class="md-table-wrap"><table$1')
      .replace(/<\/table>/g, '</table></div>');
    return html;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const $term = document.getElementById('term');
const $chat = document.getElementById('chat');
const $status = document.getElementById('status');
const $mcp = document.getElementById('mcp-status');
const $input = document.getElementById('input');
const $send = document.getElementById('send');
const $interrupt = document.getElementById('interrupt');

const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  theme: {
    background: '#000000',
    foreground: '#e6e6e6',
    cursor: '#4f8cff',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($term);
fit.fit();

let ws = null;
// Server replays the full events.jsonl on every WS connect (including
// reconnects). Track timestamps of events already rendered so we skip the
// replay on reconnect instead of re-flowing the whole chat panel each cycle.
const seenEventTs = new Set();
let reconnectDelayMs = 2000;
let connectAttempt = 0;

function sizePty() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
}

window.addEventListener('resize', () => {
  fit.fit();
  sizePty();
});

function setStatus(state) {
  $status.className = `status state-${state}`;
  $status.textContent = state;
}

function chatAppend(node) {
  $chat.appendChild(node);
  $chat.parentElement.scrollTop = $chat.parentElement.scrollHeight;
  // Also scroll within chat itself (depending on layout).
  $chat.scrollTop = $chat.scrollHeight;
}

function renderEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.kind) {
    case 'user': {
      const div = document.createElement('div');
      div.className = 'bubble user';
      div.textContent = ev.text || '(empty prompt)';
      chatAppend(div);
      break;
    }
    case 'assistant': {
      const div = document.createElement('div');
      div.className = 'bubble assistant';
      if (ev.text && ev.text.length) {
        div.innerHTML = renderMarkdown(ev.text);
      } else {
        div.classList.add('empty');
        div.textContent = ev.transcriptPath
          ? '(no assistant text — transcript empty or missing at ' + ev.transcriptPath + ')'
          : '(no transcript path provided by Stop hook)';
      }
      chatAppend(div);
      break;
    }
    case 'tool-start': {
      // Suppress tools that render through dedicated bubbles or that are noise.
      const SUPPRESSED = new Set([
        'Agent', 'Task',
        'TodoWrite',
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
        'ToolSearch',
      ]);
      if (SUPPRESSED.has(ev.tool)) break;
      const div = document.createElement('div');
      div.className = 'tool-line';
      div.textContent = `→ ${ev.tool}`;
      chatAppend(div);
      break;
    }
    case 'tool-end': {
      // Skip rendering — keeps the chat panel quiet. Could expand later.
      break;
    }
    case 'todos': {
      renderTodos(ev.todos || []);
      break;
    }
    case 'task-start': {
      renderTaskStart(ev);
      break;
    }
    case 'task-end': {
      renderTaskEnd(ev);
      break;
    }
    case 'approval-required': {
      renderApprovalRequired(ev);
      break;
    }
  }
}

function appendSystemNotice(text) {
  const div = document.createElement('div');
  div.className = 'system-notice';
  div.textContent = text;
  chatAppend(div);
}

function renderTaskStart(ev) {
  const card = document.createElement('div');
  card.className = 'bubble task-delegate task-start';

  const head = document.createElement('div');
  head.className = 'task-head';
  const pill = document.createElement('span');
  pill.className = 'task-pill';
  pill.textContent = ev.subagent || 'subagent';
  head.appendChild(pill);
  const label = document.createElement('span');
  label.className = 'task-label';
  label.textContent = 'delegated';
  head.appendChild(label);
  card.appendChild(head);

  if (ev.description) {
    const desc = document.createElement('div');
    desc.className = 'task-desc';
    desc.textContent = ev.description;
    card.appendChild(desc);
  }

  chatAppend(card);
}

// Track in-flight approval surfaces so resolving one (chat OR card) dismisses
// the other. Keyed by `${runId}:${nodeId}`.
const approvalNodes = new Map();

function approvalKey(runId, nodeId) {
  return `${runId}:${nodeId}`;
}

function renderApprovalRequired(ev) {
  const card = document.createElement('div');
  card.className = 'bubble approval-card';

  const head = document.createElement('div');
  head.className = 'approval-head';
  const pill = document.createElement('span');
  pill.className = 'approval-pill';
  pill.textContent = 'approval required';
  head.appendChild(pill);
  card.appendChild(head);

  const msg = document.createElement('div');
  msg.className = 'approval-message';
  msg.textContent = ev.message || '(no message)';
  card.appendChild(msg);

  buildApprovalControls(card, {
    workflowRunId: ev.workflowRunId,
    nodeId: ev.nodeId,
    onRejectPrompt: ev.on_reject_prompt,
  });

  chatAppend(card);
  approvalNodes.set(approvalKey(ev.workflowRunId, ev.nodeId), [card]);
}

function buildApprovalControls(parent, ctx) {
  const controls = document.createElement('div');
  controls.className = 'approval-controls';

  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'approval-btn approval-approve';
  approveBtn.textContent = 'Approve';

  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'approval-btn approval-reject';
  rejectBtn.textContent = 'Reject';

  const textWrap = document.createElement('div');
  textWrap.className = 'approval-text-wrap';
  textWrap.style.display = 'none';

  if (ctx.onRejectPrompt) {
    const hint = document.createElement('div');
    hint.className = 'approval-text-hint';
    hint.textContent = ctx.onRejectPrompt;
    textWrap.appendChild(hint);
  }

  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.className = 'approval-text';
  textarea.placeholder = ctx.onRejectPrompt || 'Optional reason';
  textWrap.appendChild(textarea);

  const submitReject = document.createElement('button');
  submitReject.type = 'button';
  submitReject.className = 'approval-btn approval-reject';
  submitReject.textContent = 'Submit reject';
  textWrap.appendChild(submitReject);

  controls.appendChild(approveBtn);
  controls.appendChild(rejectBtn);
  controls.appendChild(textWrap);
  parent.appendChild(controls);

  async function send(approved, response) {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    submitReject.disabled = true;
    try {
      const res = await fetch('/api/approval/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowRunId: ctx.workflowRunId,
          nodeId: ctx.nodeId,
          approved,
          response,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      markApprovalResolved(ctx.workflowRunId, ctx.nodeId, approved, response);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'approval-error';
      note.textContent = `Failed: ${err.message || err}`;
      parent.appendChild(note);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      submitReject.disabled = false;
    }
  }

  approveBtn.addEventListener('click', () => send(true, ''));
  rejectBtn.addEventListener('click', () => {
    textWrap.style.display = '';
    textarea.focus();
  });
  submitReject.addEventListener('click', () => send(false, textarea.value || ''));
}

function markApprovalResolved(runId, nodeId, approved, response) {
  const key = approvalKey(runId, nodeId);
  const surfaces = approvalNodes.get(key) || [];
  for (const el of surfaces) {
    el.classList.add('approval-resolved');
    const controls = el.querySelector('.approval-controls');
    if (controls) controls.remove();
    const outcome = document.createElement('div');
    outcome.className = 'approval-outcome';
    outcome.textContent = approved
      ? 'Approved.'
      : `Rejected${response ? ' — ' + response : ''}.`;
    el.appendChild(outcome);
  }
  approvalNodes.delete(key);
}

function renderTaskEnd(ev) {
  const card = document.createElement('div');
  card.className = 'bubble task-delegate task-return';

  const head = document.createElement('div');
  head.className = 'task-head';
  const pill = document.createElement('span');
  pill.className = 'task-pill';
  pill.textContent = ev.subagent || 'subagent';
  head.appendChild(pill);
  const label = document.createElement('span');
  label.className = 'task-label';
  label.textContent = 'returned';
  head.appendChild(label);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'task-result';
  if (ev.result && ev.result.length) {
    body.innerHTML = renderMarkdown(ev.result);
  } else {
    body.classList.add('empty');
    body.textContent = '(no result text)';
  }
  card.appendChild(body);

  chatAppend(card);
}

function renderTodos(todos) {
  const card = document.createElement('div');
  card.className = 'bubble assistant todo-card';

  const title = document.createElement('div');
  title.className = 'todo-title';
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  title.textContent = `Working on (${done}/${total})`;
  card.appendChild(title);

  const list = document.createElement('ul');
  list.className = 'todo-list';
  todos.forEach((t) => {
    const li = document.createElement('li');
    li.className = `todo-item todo-${t.status || 'pending'}`;
    const dot = document.createElement('span');
    dot.className = 'todo-dot';
    dot.textContent = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○';
    li.appendChild(dot);
    const txt = document.createElement('span');
    txt.className = 'todo-text';
    txt.textContent =
      t.status === 'in_progress' && t.activeForm ? t.activeForm : (t.content || '(blank)');
    li.appendChild(txt);
    list.appendChild(li);
  });
  card.appendChild(list);
  chatAppend(card);
}

function replyAsk(toolUseId, answer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'ask-reply', toolUseId, answer }));
}

function renderAsk(msg) {
  const { toolName, toolUseId, toolInput } = msg;
  const card = document.createElement('div');
  card.className = 'bubble assistant ask-card';

  const title = document.createElement('div');
  title.className = 'ask-title';
  title.textContent = toolName === 'ExitPlanMode' ? 'Plan ready — review:' : 'Claude is asking:';
  card.appendChild(title);

  if (toolName === 'ExitPlanMode') {
    const plan = document.createElement('pre');
    plan.className = 'ask-plan';
    plan.textContent = (toolInput && toolInput.plan) || '(no plan text)';
    card.appendChild(plan);

    const row = document.createElement('div');
    row.className = 'ask-options';
    [
      { label: 'Approve', value: 'approve' },
      { label: 'Reject', value: 'reject' },
    ].forEach((opt) => {
      const btn = makeOptionButton(opt.label, () => {
        replyAsk(toolUseId, opt.value);
        disableCard(card, opt.label);
      });
      row.appendChild(btn);
    });
    card.appendChild(row);
  } else {
    // AskUserQuestion shape: { questions: [{ question, header, options:[{label,description}], multiSelect }] }
    const questions = (toolInput && Array.isArray(toolInput.questions)) ? toolInput.questions : [];
    if (!questions.length) {
      const note = document.createElement('div');
      note.textContent = '(no questions in payload — sending empty answer)';
      card.appendChild(note);
      replyAsk(toolUseId, '');
    }

    // For the rig: handle the first question only. Multi-question support
    // would need staged replies.
    const q = questions[0];
    if (q) {
      const qLine = document.createElement('div');
      qLine.className = 'ask-question';
      qLine.textContent = q.question || '(blank question)';
      card.appendChild(qLine);

      const row = document.createElement('div');
      row.className = 'ask-options';
      (q.options || []).forEach((opt) => {
        const wrap = document.createElement('div');
        wrap.className = 'ask-option';
        const btn = makeOptionButton(opt.label, () => {
          replyAsk(toolUseId, opt.label);
          disableCard(card, opt.label);
        });
        wrap.appendChild(btn);
        if (opt.description) {
          const desc = document.createElement('div');
          desc.className = 'ask-option-desc';
          desc.textContent = opt.description;
          wrap.appendChild(desc);
        }
        row.appendChild(wrap);
      });
      card.appendChild(row);

      if (questions.length > 1) {
        const more = document.createElement('div');
        more.className = 'ask-note';
        more.textContent = `(+${questions.length - 1} more question${questions.length === 2 ? '' : 's'} in this call — rig only handles the first)`;
        card.appendChild(more);
      }
    }
  }

  // Cancel row — applies to both ExitPlanMode and AskUserQuestion. Sends a
  // sentinel string the hook surfaces back to the model as the deny reason.
  const cancelRow = document.createElement('div');
  cancelRow.className = 'ask-cancel-row';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ask-cancel';
  cancel.textContent = 'Cancel';
  cancel.title = 'Decline to answer — orchestrator gets a deny reason and can proceed differently.';
  cancel.addEventListener('click', () => {
    replyAsk(toolUseId, '__cancelled__');
    disableCard(card, 'Cancel');
  });
  cancelRow.appendChild(cancel);
  card.appendChild(cancelRow);

  chatAppend(card);
}

function makeOptionButton(label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ask-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function disableCard(card, chosenLabel) {
  card.querySelectorAll('button').forEach((b) => {
    b.disabled = true;
    if (b.textContent === chosenLabel) b.classList.add('chosen');
  });
  const note = document.createElement('div');
  note.className = 'ask-note';
  note.textContent = `Answered: ${chosenLabel}`;
  card.appendChild(note);
}

function connect() {
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    if (connectAttempt > 0) term.writeln('\x1b[2m[client] reconnected\x1b[0m');
    else term.writeln('\x1b[2m[client] connected\x1b[0m');
    connectAttempt = 0;
    reconnectDelayMs = 2000;
    sizePty();
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'raw':
        term.write(msg.text);
        break;
      case 'state':
        setStatus(msg.state);
        break;
      case 'turn-end':
        term.writeln('\r\n\x1b[2m[turn-end]\x1b[0m');
        break;
      case 'event': {
        const ts = msg.event && msg.event.ts;
        if (ts && seenEventTs.has(ts)) break;
        if (ts) seenEventTs.add(ts);
        renderEvent(msg.event);
        break;
      }
      case 'ask':
        renderAsk(msg);
        break;
      case 'exit':
        term.writeln(`\r\n\x1b[31m[session exited code=${msg.code} signal=${msg.signal}]\x1b[0m`);
        break;
    }
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected');
    // Only log the first close — subsequent retries stay quiet to avoid
    // flooding the term while the server is bouncing. Backoff: 2 → 5 → 15 → 30s cap.
    if (connectAttempt === 0) {
      term.writeln('\r\n\x1b[33m[client] socket closed; retrying with backoff\x1b[0m');
    }
    connectAttempt += 1;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs === 2000 ? 5000 : reconnectDelayMs === 5000 ? 15000 : 30000, 30000);
    setTimeout(connect, delay);
  });

  ws.addEventListener('error', () => {
    // 'close' will fire too
  });
}

function send() {
  const text = $input.value;
  if (!text.trim()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'send', text }));
  $input.value = '';
}

$send.addEventListener('click', send);
$input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    send();
  }
});
$interrupt.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'interrupt' }));
});

const $channelSend = document.getElementById('channel-send');
if ($channelSend) {
  $channelSend.addEventListener('click', async () => {
    const message = window.prompt('Channel event body:');
    if (message == null) return;
    const text = String(message).trim();
    if (!text) return;
    try {
      const res = await fetch('/api/channel-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json().catch(() => ({}));
      const note = document.createElement('div');
      note.className = 'tool-line';
      note.textContent = data && data.ok
        ? `channel → "${text}"`
        : `channel POST failed: ${data && (data.error || data.status) || res.status}`;
      chatAppend(note);
    } catch (err) {
      const note = document.createElement('div');
      note.className = 'tool-line';
      note.textContent = `channel POST error: ${err && err.message ? err.message : String(err)}`;
      chatAppend(note);
    }
  });
}

const $wtList = document.getElementById('wt-list');
const $wtCreate = document.getElementById('wt-create');

function renderWorktrees(entries) {
  if (!$wtList) return;
  $wtList.innerHTML = '';
  if (!entries || !entries.length) {
    const empty = document.createElement('div');
    empty.className = 'wt-empty';
    empty.textContent = 'no worktrees';
    $wtList.appendChild(empty);
    return;
  }
  entries.forEach((w, idx) => {
    const item = document.createElement('div');
    // First entry from `git worktree list --porcelain` is always the main repo.
    const isMain = idx === 0;
    item.className = 'wt-item ' + (isMain ? 'wt-main' : 'wt-branch');

    const row = document.createElement('div');
    row.className = 'wt-item-row';
    const name = document.createElement('span');
    name.className = 'wt-name';
    name.textContent = w.branch || '(detached)';
    row.appendChild(name);
    if (!isMain) {
      const del = document.createElement('button');
      del.className = 'wt-destroy';
      del.type = 'button';
      del.textContent = 'remove';
      del.title = 'git worktree remove';
      del.addEventListener('click', () => destroyWorktree(w.path));
      row.appendChild(del);
    }
    item.appendChild(row);

    const path = document.createElement('div');
    path.className = 'wt-path';
    path.textContent = w.path;
    item.appendChild(path);

    if (w.head) {
      const head = document.createElement('div');
      head.className = 'wt-head';
      head.textContent = w.head.slice(0, 7);
      item.appendChild(head);
    }

    $wtList.appendChild(item);
  });
}

async function pollWorktrees() {
  try {
    const res = await fetch('/api/worktrees', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    renderWorktrees(data.worktrees || []);
  } catch {
    /* ignore — next poll retries */
  }
}

async function createWorktree() {
  const name = window.prompt('New worktree / branch name:');
  if (name == null) return;
  const trimmed = String(name).trim();
  if (!trimmed) return;
  try {
    const res = await fetch('/api/worktrees/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      window.alert('create failed: ' + (data.error || res.status));
    }
  } catch (err) {
    window.alert('create error: ' + (err && err.message ? err.message : String(err)));
  }
  pollWorktrees();
}

async function destroyWorktree(target) {
  if (!window.confirm('Remove worktree:\n' + target + '\n\n(force=true if it has uncommitted changes)')) return;
  try {
    const res = await fetch('/api/worktrees/destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, force: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      window.alert('destroy failed: ' + (data.error || res.status));
    }
  } catch (err) {
    window.alert('destroy error: ' + (err && err.message ? err.message : String(err)));
  }
  pollWorktrees();
}

if ($wtCreate) $wtCreate.addEventListener('click', createWorktree);
setInterval(pollWorktrees, 3000);
pollWorktrees();

const $wiList = document.getElementById('wi-list');

let cachedProject = null;

async function loadProject() {
  try {
    const res = await fetch('/api/project', { cache: 'no-store' });
    if (!res.ok) return;
    cachedProject = await res.json();
  } catch {
    /* retry on next poll */
  }
}

function renderWorkItems(workItems) {
  if (!$wiList) return;
  $wiList.innerHTML = '';
  if (!workItems || !workItems.length) {
    const empty = document.createElement('div');
    empty.className = 'wi-empty';
    empty.textContent = 'no work items';
    $wiList.appendChild(empty);
    return;
  }
  workItems.forEach((workItem) => {
    const item = document.createElement('div');
    item.className = 'wi-item';

    const head = document.createElement('div');
    head.className = 'wi-head';
    const title = document.createElement('span');
    title.className = 'wi-title';
    title.textContent = workItem.title;
    head.appendChild(title);
    const stagePill = document.createElement('span');
    stagePill.className = 'wi-stage';
    stagePill.textContent = workItem.stageId;
    head.appendChild(stagePill);
    const wiStatus = workItem.status || 'pending';
    const statusPill = document.createElement('span');
    statusPill.className = `wi-status wi-status-${wiStatus}`;
    statusPill.textContent = wiStatus;
    if (workItem.statusReason) statusPill.title = workItem.statusReason;
    head.appendChild(statusPill);
    item.appendChild(head);

    if (workItem.statusReason && wiStatus === 'blocked') {
      const reason = document.createElement('div');
      reason.className = 'wi-reason';
      reason.textContent = workItem.statusReason;
      item.appendChild(reason);
    }

    const summary =
      workItem.fields && typeof workItem.fields.summary === 'string' ? workItem.fields.summary : null;
    const lastResult =
      workItem.fields && typeof workItem.fields.lastResult === 'string' ? workItem.fields.lastResult : null;
    const resultText = summary || lastResult;
    if (resultText) {
      const result = document.createElement('div');
      result.className = 'wi-result';
      result.textContent = resultText;
      item.appendChild(result);
    }

    const lastHistory = workItem.history && workItem.history.length ? workItem.history[workItem.history.length - 1] : null;
    if (lastHistory) {
      const meta = document.createElement('div');
      meta.className = 'wi-meta';
      const ts = lastHistory.ts ? new Date(lastHistory.ts).toLocaleTimeString() : '';
      const kind = lastHistory.kind || '';
      meta.textContent = `${kind} • ${ts}`;
      item.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'wi-actions';
    const stages = (cachedProject && cachedProject.stages) || [];
    stages
      .filter((s) => s.id !== workItem.stageId)
      .forEach((s) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wi-move';
        btn.textContent = `→ ${s.id}`;
        btn.title = `Move ${workItem.title} to ${s.id}`;
        btn.addEventListener('click', () => moveWorkItem(workItem.id, s.id));
        actions.appendChild(btn);
      });
    item.appendChild(actions);

    $wiList.appendChild(item);
  });
}

async function moveWorkItem(id, toStage) {
  try {
    const res = await fetch('/api/work-items/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, toStage }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      // 409 = trigger-resolution failure (ambiguous / no valid workflow). Surface
      // in chat so the user can read it alongside everything else; reserve
      // window.alert for unexpected 500s.
      if (res.status === 409) {
        appendSystemNotice(`Move ${id} → ${toStage} rejected: ${data.error}`);
      } else {
        window.alert('move failed: ' + (data.error || res.status));
      }
    }
  } catch (err) {
    window.alert('move error: ' + (err && err.message ? err.message : String(err)));
  }
  pollWorkItems();
}

async function pollWorkItems() {
  try {
    const res = await fetch('/api/work-items', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    renderWorkItems(data.workItems || []);
  } catch {
    /* ignore — next poll retries */
  }
}

loadProject().then(pollWorkItems);
setInterval(pollWorkItems, 3000);

const $wfList = document.getElementById('wf-list');
const $wfReload = document.getElementById('wf-reload');

function renderWorkflows(state) {
  if (!$wfList) return;
  $wfList.innerHTML = '';
  const valid = (state && state.valid) || [];
  const invalid = (state && state.invalid) || [];
  if (!valid.length && !invalid.length) {
    const empty = document.createElement('div');
    empty.className = 'wf-empty';
    empty.textContent = 'no workflows';
    $wfList.appendChild(empty);
    return;
  }
  valid.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'wf-item';

    const head = document.createElement('div');
    head.className = 'wf-head';
    const name = document.createElement('span');
    name.className = 'wf-name';
    name.textContent = w.id;
    name.title = w.fileName;
    head.appendChild(name);
    if (w.stageId) {
      const stage = document.createElement('span');
      stage.className = 'wf-stage';
      stage.textContent = '→ ' + w.stageId;
      head.appendChild(stage);
    }
    const status = document.createElement('span');
    status.className = 'wf-status wf-status-valid';
    status.textContent = 'valid';
    head.appendChild(status);
    item.appendChild(head);

    if (w.subagent) {
      const sub = document.createElement('span');
      sub.className = 'wf-subagent';
      sub.textContent = w.subagent;
      item.appendChild(sub);
    }

    $wfList.appendChild(item);
  });
  invalid.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'wf-item wf-invalid';

    const head = document.createElement('div');
    head.className = 'wf-head';
    const name = document.createElement('span');
    name.className = 'wf-name';
    name.textContent = w.fileName;
    head.appendChild(name);
    if (w.partialStageId) {
      const stage = document.createElement('span');
      stage.className = 'wf-stage';
      stage.textContent = '→ ' + w.partialStageId;
      head.appendChild(stage);
    }
    const status = document.createElement('span');
    status.className = 'wf-status wf-status-invalid';
    status.textContent = 'invalid';
    head.appendChild(status);
    item.appendChild(head);

    if (w.errors && w.errors.length) {
      const errs = document.createElement('div');
      errs.className = 'wf-errors';
      w.errors.forEach((e) => {
        const line = document.createElement('div');
        line.className = 'wf-error-line';
        if (e.path) {
          const p = document.createElement('span');
          p.className = 'wf-error-path';
          p.textContent = e.path + ': ';
          line.appendChild(p);
        }
        const m = document.createElement('span');
        m.textContent = e.message || '(no message)';
        line.appendChild(m);
        errs.appendChild(line);
      });
      item.appendChild(errs);
    }

    $wfList.appendChild(item);
  });
}

async function pollWorkflows() {
  try {
    const res = await fetch('/api/workflows', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    renderWorkflows(data);
  } catch {
    /* retry next poll */
  }
}

if ($wfReload) $wfReload.addEventListener('click', pollWorkflows);
setInterval(pollWorkflows, 3000);
pollWorkflows();

// Pending approvals — Workflows-pane card surface. Polls so a fresh browser
// reload still shows in-flight approvals (the chat bubble is event-driven and
// won't replay on reload).
const $approvalsList = document.getElementById('approvals-list');

function renderApprovals(approvals) {
  if (!$approvalsList) return;
  $approvalsList.innerHTML = '';
  if (!approvals || !approvals.length) {
    const empty = document.createElement('div');
    empty.className = 'approvals-empty';
    empty.textContent = 'no pending approvals';
    $approvalsList.appendChild(empty);
    return;
  }
  for (const a of approvals) {
    const card = document.createElement('div');
    card.className = 'approval-card approval-pane-card';

    const msg = document.createElement('div');
    msg.className = 'approval-message';
    msg.textContent = a.message || '(no message)';
    card.appendChild(msg);

    buildApprovalControls(card, {
      workflowRunId: a.workflowRunId,
      nodeId: a.nodeId,
      onRejectPrompt: a.onRejectPrompt,
    });

    $approvalsList.appendChild(card);

    // Register so resolving in chat also clears this card (and vice versa).
    const key = approvalKey(a.workflowRunId, a.nodeId);
    const existing = approvalNodes.get(key) || [];
    existing.push(card);
    approvalNodes.set(key, existing);
  }
}

async function pollApprovals() {
  try {
    const res = await fetch('/api/approvals', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    renderApprovals(data.approvals || []);
  } catch {
    /* retry next poll */
  }
}

setInterval(pollApprovals, 3000);
pollApprovals();

async function pollMcp() {
  if (!$mcp) return;
  try {
    const res = await fetch('/api/mcp-status', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (data.alive) {
      $mcp.className = 'mcp-pill mcp-up';
      $mcp.textContent = `MCP: ${data.toolCount ?? 0}`;
      if (Array.isArray(data.tools) && data.tools.length) {
        $mcp.title = `tools: ${data.tools.join(', ')}`;
      }
    } else {
      $mcp.className = 'mcp-pill mcp-down';
      $mcp.textContent = 'MCP: down';
      $mcp.title = 'MCP server not reporting (may not have been spawned yet)';
    }
  } catch {
    $mcp.className = 'mcp-pill mcp-down';
    $mcp.textContent = 'MCP: ?';
  }
}

setInterval(pollMcp, 3000);
pollMcp();

connect();
