# Design: DAG workflows (v2)

Supersedes `DESIGN-WORKFLOWS-AND-CONTRACTS.md`. The "one subagent runs a checklist" model from Slice 8b is dead.

Modelled on Archon's workflow engine (`E:/Claude Code Projects/Personal/Archon-upstream/packages/workflows/`). Same shape, one substitution: AI nodes fire CC subagents through the orchestrator instead of SDK calls.

## What changed and why

- 8b shipped one workflow = one subagent that runs every step inside a single Task. Wrong model.
- The right model: a workflow is a graph. Each node is its own job. The runtime drives, node by node.
- The orchestrator (a long-lived CC instance) is allowed to fire any number of subagents in one turn. That's the seam that makes the graph model work for us. Subagents can't fire subagents, but the orchestrator can.

## Concept

- **Workflow** — a YAML file declaring a graph of nodes
- **Node** — one job in the graph. Has an id, dependencies, and a type-specific body
- **Run** — one execution of the graph
- **Runtime** — the thing that finds ready nodes, runs them per type, captures output, advances

## Workflow file shape

```yaml
id: my-workflow
description: ...

triggers:
  on_enter: { stage_id: review }   # work item move triggers this
  callable: true                   # orchestrator can call via pc_run_workflow

inputs:
  prdText: string
outputs:
  jiraStories: array

worktree: auto                     # auto | none

nodes:
  - id: ...
    ...
```

Top-level fields are similar to 8b. The big change is `nodes:` is now a graph, not a checklist.

## Seven node types

All nodes share these base fields:
- `id` — unique within the workflow
- `depends_on` — array of node ids this node waits for
- `when` — optional condition; if it evaluates to false, the node is skipped
- `trigger_rule` — how to react when deps finished:
  - `all_success` (default) — every dep must have succeeded
  - `one_success` — at least one dep succeeded
  - `all_done` — every dep finished, success or fail
  - `none_failed_min_one_success` — at least one succeeded, none failed
- `done_when` — optional completion contract (same shape as 8b: `files-non-empty` + `output-fields-non-empty`)
- `timeout` — optional, in milliseconds
- `retry` — deferred to a later slice

Then exactly one type-body field per node:

### 1. subagent — delegates to a CC subagent

```yaml
- id: explore
  subagent: researcher
  prompt: "Read every file under {{worktreePath}}. Summarize what you find."
```

Runtime renders the prompt and posts a channel event. Orchestrator wakes, Tasks the subagent. Subagent finishes its work and calls `pc_complete_node` with its output.

### 2. bash — runtime runs a shell command directly

```yaml
- id: check-base
  bash: |
    set -euo pipefail
    git rev-parse --abbrev-ref HEAD
  timeout: 30000
```

No agent involved. Output = `{ stdout, stderr, exitCode }`. A non-zero exit code is a node failure.

### 3. script — runtime runs typescript or python directly

```yaml
- id: parse
  script: |
    const raw = process.argv[2];
    console.log(JSON.parse(raw).title);
  runtime: node                # node | python
```

Same shape as bash, just a higher-level language.

### 4. approval — pauses the run, waits for a human

```yaml
- id: approve-plan
  approval:
    message: "Approve the implementation plan?"
    on_reject:
      prompt: "Tell me what to change."
```

Runtime pushes a UI event. The web app shows a card with approve / reject buttons + free text. Run goes to `paused`. On response, run resumes to `in-progress`. Output = `{ approved: bool, response: string }`.

### 5. cancel — terminates the run

```yaml
- id: out-of-scope
  when: "$scope.output.outOfScope == true"
  cancel: "Scope check rejected the request."
```

Run status flips to `cancelled`. No further nodes fire.

### 6. workflow — runs another workflow inline

```yaml
- id: decompose
  workflow: prd-to-stories
  inputs:
    prdText: $extract.output
```

This is the answer to "workflow A calls workflow B in the middle of A." The sub-workflow runs as a child of the current run. Its outputs become this node's output. The parent waits, then continues.

- Inherits work item + worktree from the parent
- Same workflow id appearing twice in the ancestry → cycle, rejected at dispatch
- Max nesting depth = 10

### 7. loop — iterates a body until a condition

```yaml
- id: refine
  loop:
    body:
      - id: critique
        subagent: critic
        prompt: "Review $write.output. Approve or suggest fixes."
      - id: rewrite
        subagent: writer
        depends_on: [critique]
        prompt: "Apply: $critique.output"
    until: "$critique.output.approved == true"
    max_iterations: 5
```

Body is a sub-graph that runs every iteration. `until` is evaluated after each iteration. `max_iterations` caps runaway loops.

## How execution works

The runtime runs a simple loop:

1. Find every node whose `depends_on` is satisfied per its `trigger_rule`, whose `when` isn't false, that hasn't run yet
2. For each ready node, run it according to its type:
   - **subagent** → channel event → orchestrator Tasks → subagent calls `pc_complete_node`
   - **bash** / **script** → exec directly, capture output, mark complete
   - **approval** → UI event, wait for response
   - **cancel** → terminate the run, stop
   - **workflow** → start a child run, wait for it, capture its output
   - **loop** → run the body, check `until`, repeat or stop
3. When a node finishes (success or fail), re-check who's ready
4. Repeat until no nodes are ready
5. Run is `complete` if every reachable node succeeded. `failed` if a failure isn't tolerated by dependents' trigger rules.

**Parallel nodes.** When multiple nodes are ready in the same pass, they all fire at once. Subagent nodes go out as separate channel events — the orchestrator can fire multiple Tasks in a single turn.

## Data flow

Every completed node's output is stored under its id. Later nodes reference it as `$<node-id>.output` (or `$<node-id>.output.<field>`).

Substitution happens at dispatch — by the time a prompt or bash script is handed off, all `$node.output` tokens have been replaced.

Used in:
- subagent `prompt`
- bash / script bodies
- `when` and `until` conditions
- nested workflow `inputs:` mappings

Expression syntax in `when` / `until` is a tiny JS-ish subset: equality (`==`, `!=`), comparisons (`<`, `>`, `<=`, `>=`), boolean (`&&`, `||`, `!`), dotted access (`$node.output.field.sub`). Hand-rolled, no eval, no libraries.

## MCP tools

After this rework the tool surface is:

- `pc_log` — unchanged
- `pc_create_worktree`, `pc_list_worktrees`, `pc_destroy_worktree` — unchanged
- `pc_move_work_item`, `pc_update_work_item` — unchanged
- `pc_complete_node({ workflowRunId, nodeId, output })` — subagent's contract gate (replaces both `pc_complete_workflow` and `pc_step_complete`)
- `pc_node_failed({ workflowRunId, nodeId, reason })` — explicit subagent failure path
- `pc_run_workflow({ name, input })` — orchestrator-callable entry

**Retired:** `pc_complete_workflow`, `pc_step_complete`.

## Triggers

Three ways to start a workflow run:

1. **Work item move.** Work item enters a stage; runtime fires the workflow whose `triggers.on_enter.stage_id` matches.
2. **Orchestrator call.** Orchestrator calls `pc_run_workflow({ name, input })`.
3. **Parent workflow.** A `workflow:` node in a parent fires us.

Stage_id and name lookup both follow the same four-case rule from 8b:
- 0 valid → silent move (for stage_id) / "unknown workflow" error (for name)
- 1 valid → fire
- 2+ valid → "ambiguous", reject
- 0 valid + 1+ invalid → "no valid workflow", reject

## Run lifecycle

States: `pending` → `in-progress` → (`complete` | `failed` | `cancelled` | `paused`)

- `paused` is new — exists for approval nodes. Resumes to `in-progress` on response.
- While a run is `in-progress`, the work item is locked: can't move it, can't start a second concurrent run on it.

## Worktree policy

- `worktree: auto` (default):
  - Work-item-triggered run → use / create `wi-<id>`
  - Orchestrator-triggered run → use / create `run-<runId>`
- `worktree: none` — no worktree, subagents have no path-guard boundary
- Nested workflow runs always inherit the parent's worktree; they never get their own

## Subagent node specifics

Each subagent node = one orchestrator Task call.

Channel event the runtime posts carries:
- The rendered prompt (substitutions already applied)
- `[workflowRunId: <id>]`
- `[nodeId: <id>]`
- `[worktree: <abs path>]` (if applicable)

Subagent obligations:
- Call `pc_complete_node({ workflowRunId, nodeId, output })` when done
- OR `pc_node_failed({ workflowRunId, nodeId, reason })` on hard failure
- If the subagent's Task returns without either, the turn-end safety net marks the node failed with reason "subagent returned without closing the node"

File operations inside subagent turns must use Bash heredoc + Edit (CC v2.1.140 soft-blocks `Write` inside subagent turns). Workflow YAML prompts should phrase file creation accordingly. Carries over from Session H point 7.

## Bash / script node specifics

- Direct `execFile` from the runtime
- Stdout captured as `output.stdout`; stderr as `output.stderr`; exit code as `output.exitCode`
- Non-zero exit = node failure unless `trigger_rule` on dependents tolerates it
- `timeout` is a hard ceiling; exceeded → node failed with reason "timeout"
- Bash runs in the worktree's directory if a worktree is bound, else the workspace root

## Approval node specifics

- Runtime posts `approval-required` UI event with `{ workflowRunId, nodeId, message, on_reject }`
- Two surfaces show the approval, both required:
  - **Inline in the orchestrator chat** — bubble with approve / reject buttons + text field
  - **Card in the Workflows pane** — persists; survives chat scrolling
- Both surfaces share the same POST endpoint; responding from either resolves the approval
- POST `/api/approval/respond` body: `{ workflowRunId, nodeId, approved: bool, response: string }`
- Run status = `paused` while waiting; flips to `in-progress` on response
- Output: `{ approved, response }` — referenceable by later nodes
- Future: a dedicated "human notification" section of the UI will consolidate this and any other human-attention surfaces. Out of scope for Slice 9; the two surfaces above are the interim.

## Workflow-as-node specifics

- Child WorkflowRun row, `parentRunId` pointing at the parent
- Cycle protection: scan ancestry on dispatch; same workflow id present → reject with "cycle: A → B → A"
- Depth cap: 10 levels deep → reject with "depth exceeded"
- Inherits work item + worktree, doesn't create new ones
- Output = the child run's outputs object

## Loop node specifics

- Body is a sub-graph (mini-DAG with its own depends_on between body nodes)
- Each iteration is its own scoped execution — node outputs from iteration N don't carry into N+1's body
- The previous iteration's body outputs are available as `$loop.last.<node-id>.output` (for `until` and for the next iteration's prompts)
- `until` evaluated after each iteration
- `max_iterations` is a hard cap; exceeded → loop node fails with reason "max iterations reached"

## What this replaces from 8b

| 8b | v2 |
|---|---|
| `subagent:` field on workflow root | per-node `subagent:` on subagent nodes |
| Single-Task-runs-checklist execution | DAG runtime, node by node |
| `pc_complete_workflow` + `pc_step_complete` | `pc_complete_node` + `pc_node_failed` |
| `done_when` on workflow root | `done_when` optional per node |
| Channel event per workflow | channel event per ready subagent node |
| `review-research.yaml` (1-subagent checklist) | rewritten as a 2-node DAG (explore → write-findings) |
| Run states: pending / in-progress / blocked / complete / failed | adds `paused`, `cancelled` |

## Calls I'm making (push back on any)

1. **Per-node `done_when` is optional.** Bash / script use exit code, no contract needed. AI nodes opt in.
2. **Workflow-as-node inherits the parent's worktree.** No fresh worktree per nested call. Simpler and matches the "same work, different agent" mental model.
3. **Loop bodies can wrap any node type.** Not just AI. You could loop a bash check, an approval, a sub-workflow.
4. **Cycle detection is a hard rule, no escape hatch.** Same workflow id in ancestry → rejected.
5. **One concurrent run per workflow per work item.** Trying to fire a second is rejected with "work item locked." Matches 8b's lock.
6. **No per-node retry in v1.** Archon has it. Real workflows want it. Deferring to keep this slice scoped.
7. **`timeout` baked in for bash / script only.** AI nodes default to no timeout (the safety net handles unresponsive subagents).
8. **Expression syntax is a tiny hand-rolled subset.** Not jsonata, not jq, not eval. Just enough for the conditions we'll actually write.
9. **`pc_step_complete` retired.** With one node = one Task call, the orchestrator naturally sees node boundaries — no separate progress tool needed.
10. **YAML stays the format.** Not JSON, not TOML. Matches Archon and matches 8b.

## Decisions on prior open questions (2026-05-16)

1. **Loop `until` evaluated after each iteration.** Confirmed. Body always runs at least once.
2. **Approval surfaces both in chat AND in the Workflows pane.** A dedicated "human notification" section of the UI is a future consolidation; interim solution is both surfaces above.
3. **Per-node retry deferred.** Build when a real workflow needs it.
4. **Pre/post hooks deferred.** Workaround: add a bash node before/after the target.
5. **Per-node sandbox deferred.** Path-guard hook covers worktree containment for v1.
6. **No parallel subagent cap.** Workflow author owns it. Add a cap if real workflows hit a wall.

## Deferred (for later slices, not Slice 9)

- Human notification UI section (consolidates approvals + any other attention-required surfaces)
- Per-node retry policy
- Pre/post hooks on nodes
- Per-node sandbox settings
- Parallel subagent cap (only if needed)

## Implementation order (inside Slice 9)

User picked: all 7 node types land in one slice. Inside the slice, a sane build order:

1. Domain types: `Workflow`, `DagNode` union (7 variants), `WorkflowRun` (with paused/cancelled), `NodeOutput`
2. Validator: hand-rolled, covers all 7 types
3. Runtime: graph scheduler + ready-set finder (no dispatch yet)
4. Subagent dispatch + `pc_complete_node` + `pc_node_failed` MCP tools
5. Bash dispatch (direct exec + timeout + capture)
6. Script dispatch (node + python runtimes)
7. Approval dispatch + UI surface + `/api/approval/respond`
8. Cancel dispatch
9. Workflow-as-node dispatch + cycle protection + depth cap
10. Loop dispatch + `until` evaluator
11. Output substitution (`$node.output` in prompts / bash / scripts / conditions)
12. Trigger paths (stage_id move, `pc_run_workflow`, parent workflow)
13. Rewrite `review-research.yaml` as a 2-node DAG; add a few more example workflows that exercise each node type
14. User test plan (per node type + integration test that uses several together)

This is a multi-session build. Will land as one continuous slice in BUILDOUT.md but with internal milestones tickable in order.

## Resources

- `E:/Claude Code Projects/Personal/Archon-upstream/packages/workflows/src/` — reference implementation (DAG executor, validator, schemas)
- `E:/Claude Code Projects/Personal/Archon-upstream/.archon/workflows/defaults/` — real workflow YAML examples
- `DESIGN-WORKFLOWS-AND-CONTRACTS.md` — superseded; kept as journey doc
- `BUILDOUT.md` — Slice 8b log explains the model this replaces and the CC v2.1.140 constraints we work around
