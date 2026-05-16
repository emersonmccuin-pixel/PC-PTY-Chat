# Design: Workflows + Completion Contracts

Cold-readable artifact. Implementation slices for completion contracts + workflow lifecycle fall out of this document.

Supersedes the open questions in `PLANNING-CONTRACTS-MODELS.md`. That doc captures the journey; this one is the answer.

## What changed from the planning doc

- **Workflows became callable units of work** — like functions. Invoked by a card move OR by the orchestrator directly OR as a chain from another workflow.
- **Models A vs B collapsed as a design question.** A workflow is intrinsically single-Task (one subagent owns the run end-to-end). Durability across sessions and multi-stage flows are handled by *chaining workflows*, not by chunking one workflow across multiple Tasks.
- **The contract moved up to the workflow level.** Not per-step, not per-node. Each workflow has one `done_when` gate at its completion boundary.
- **Sub-workflows = chained workflows.** Output of A feeds input of B. Avoids the CC v2.1.140 nested-Task block by never nesting Tasks — the runtime brokers the handoff.
- **No mid-workflow human waits in v1.** Deferred. Approvals happen between workflows via card-node moves.

## Decisions update (2026-05-16)

Between Session E (this doc's authoring) and Slice 8 implementation, a vocabulary parity pass + a few semantic shifts were locked in. The body below still reads with "card" / "node" in places — read it with these substitutions applied.

- **Vocabulary parity with Project Companion.** Card → WorkItem; kanban container `Workflow { nodes[] }` → `Project { stages[] }`; WorkflowNode (kanban column) → Stage; `cardId` → `workItemId`, `nodeId` → `stageId`. Lands in Slice 8a as a pure rename pass before any workflow runtime changes.
- **Trigger model: stage_id only.** Workflows trigger on `triggers.on_enter.stage_id`. PC's `role` field (which this doc never used, but PC has) is dropped. Stage id is the immutable handle (auto-slugged from the initial name, locked at create); stage name is freely editable.
- **One workflow per stage on enter.** If two workflows declare the same `stage_id` trigger, the move is rejected with "ambiguous trigger". Multi-step pipelines live inside one workflow's `nodes`, not across multiple workflows triggered by the same stage.
- **Inputs/outputs live on the workflow.** Not on the stage's on_enter (the "Card-triggered" example below shows the older pattern). Workflow is self-contained — port one YAML file, get the whole behavior. Stage just triggers.
- **Hand-rolled validator.** No zod for the rig. PC port will rewrite the validator anyway since PC's schema is much bigger.
- **`subagent:` field on workflow** is a rig extension. PC doesn't have it yet; Phase 9-C will fold it in.
- **`workflowYamlSnapshot` frozen at dispatch.** Adopted from PC — workflow run carries the YAML text it was dispatched against; live edits don't perturb running workflows.
- **Implementation order split.** Original Slice 8 split into 8a (vocabulary rename) + 8b (new workflow runtime). 8a unblocked 2026-05-16; 8b follows.

## Core concepts

- **Workflow.** A callable procedure. Has a subagent, ordered steps, input + output schemas, and a completion contract. Runs end-to-end in one Task. Returns output via `pc_complete_workflow`.
- **Card.** A work item flowing through workflow nodes (stages). Long-lived; survives Task restarts. Each node can fire a workflow on `on_enter`.
- **Contract.** The `done_when` block on a workflow definition. Validated by `pc_complete_workflow`. Checks files in the worktree + fields in the workflow's output.
- **Chain.** Workflow A's output becomes workflow B's input. Static (declared in A's file) or dynamic (A's subagent sets `next_workflow` in output).
- **Sub-workflow.** A workflow that runs as a chained continuation. Not a nested Task — the runtime queues B after A completes.

## Workflow definition format

```json
{
  "id": "decompose-prd-to-jira",
  "subagent": "product-decomposer",

  "input_schema": {
    "prdText": "string",
    "jiraProject": "string",
    "parentEpic": "string?"
  },

  "steps": [
    { "id": "parse",  "instruction": "Read the PRD. Identify discrete user stories." },
    { "id": "draft",  "instruction": "Draft each story: title, description, AC as Gherkin." },
    { "id": "create", "instruction": "Call jira_create_story for each. Collect issue keys." }
  ],

  "done_when": {
    "output-fields-non-empty": ["createdStories"]
  },

  "output_schema": {
    "createdStories": "{ key: string, title: string, url: string }[]"
  },

  "chain_to": null
}
```

### Field reference

| Field | Required | Purpose |
|---|---|---|
| `id` | yes | Unique workflow identifier. Used as file name (`<id>.json`). |
| `subagent` | yes | Name of the subagent that runs this workflow. Matches a file in `workspace/.claude/agents/`. |
| `input_schema` | yes | Names + types of inputs the workflow needs. `?` suffix = optional. Runtime validates before invocation. |
| `steps` | yes | Ordered list. Each step has `id` + `instruction`. Instructions support `{{name}}` substitution from inputs. Subagent calls `pc_step_complete` after each (progress reporting only, no gating). |
| `done_when` | yes | The completion contract. See "Predicate types". |
| `output_schema` | yes | Names + types of fields the workflow produces. Returned to caller; validated against `done_when`. |
| `chain_to` | optional | Static next-workflow name. `null` or omitted = terminal. Can be overridden by subagent setting `next_workflow` in output. |

### Templating

Step instructions support `{{name}}` substitution from inputs. The reserved name `{{worktreePath}}` is auto-populated when the workflow runs inside a worktree (card-triggered path).

## Predicate types (the contract DSL)

Two predicate kinds in v1. Add more when a real workflow forces it.

### `files-non-empty`

```json
"files-non-empty": ["findings.md", "docs/**/*.md"]
```

- Paths are **worktree-relative**. Absolute paths rejected.
- Globs supported. Must match ≥1 file.
- Each matched file must exist AND be **>0 bytes**. Zero-byte files do not satisfy.

### `output-fields-non-empty`

```json
"output-fields-non-empty": ["summary", "createdStories"]
```

- Field names match keys in `output_schema`.
- "Empty" = `null`, `undefined`, `""` (after trim), `[]`, `{}`.
- `0` and `false` are **valid** (a numeric or boolean field can legitimately be zero/false).

### Combining

A workflow can declare both predicate kinds. Both must pass for the contract to succeed.

## MCP tools

Three new tools. One existing tool changes role.

### `pc_step_complete({ workflowRunId, stepId })`

Progress reporting. Subagent calls this after completing each step. Runtime updates the workflow run record (current step) and pushes an event to the UI. **Does not validate anything** — purely positional.

Returns: `{ ok: true }`. Idempotent on `stepId`.

### `pc_complete_workflow({ workflowRunId, output, next_workflow? })`

The contract gate. The subagent's final action.

Arguments:
- `workflowRunId` — issued by the runtime when the workflow started.
- `output` — object matching the workflow's `output_schema`.
- `next_workflow` — optional; subagent's runtime chain choice. Overrides static `chain_to`. Pass `null` to short-circuit a static chain.

Runtime behavior:
1. Look up workflow definition by `workflowRunId`.
2. Validate `output` against `output_schema` (shape check).
3. Validate against `done_when`:
   - Each `files-non-empty` path resolved relative to the workflow's worktree.
   - Each `output-fields-non-empty` field checked against the submitted output.
4. **On pass:**
   - Persist output. For card-triggered runs, map output → `card.fields` per the node's `outputs` mapping.
   - Mark workflow run `complete`.
   - If `next_workflow` (dynamic) OR `chain_to` (static) set → queue next workflow run with current output as input.
   - Return `{ ok: true }`.
5. **On fail:**
   - Return `{ ok: false, missing: [ { kind: 'file' | 'field', name: string, reason: string }, ... ] }`.
   - Workflow run stays `in-progress`; subagent retries inside the same Task.

### `pc_run_workflow({ name, input })`

Orchestrator-callable. Starts a workflow not tied to a card move.

Arguments:
- `name` — workflow id.
- `input` — object matching the workflow's `input_schema`.

Runtime behavior:
1. Validate input against `input_schema`.
2. Create workflow run record.
3. Direct path (orchestrator is the caller AND the Task-spawner): the orchestrator spawns the workflow's subagent directly via Task. Workflow definition + input rendered into the Task prompt.
4. Workflow output returned to orchestrator when Task completes (sync from the orchestrator's perspective).

### `pc_update_card({ id, fields })` — DEMOTED

Stays available as a low-level admin tool. **Not part of the workflow path.** Subagents inside workflows should never call this — output goes through `pc_complete_workflow`. Used only for manual admin operations from the orchestrator.

If misused: tighten per-agent tool allowlists. Defer until we see it happen.

## Card status state machine

New field on `Card`: `status: 'pending' | 'in-progress' | 'blocked' | 'complete' | 'failed'`.

```
pending ──(move into node with on_enter)──► in-progress
in-progress ──(pc_complete_workflow ok)──► pending (next node) | complete (terminal)
in-progress ──(retry cap OR safety net)──► blocked
blocked ──(human resolves)──► pending
pending ──(manual)──► failed
```

State meanings:
- `pending`: card is at a node, no workflow running. Default.
- `in-progress`: a workflow is running for this card. Locks against `pc_move_card`.
- `blocked`: contract failed too many times, or subagent returned without calling `pc_complete_workflow`. Awaits human action. UI shows reason.
- `complete`: card is at a terminal node.
- `failed`: manually marked dead. UI offers "remove" action.

### Locking

While status is `in-progress`:
- `pc_move_card` rejects: `{ error: 'card locked: workflow in progress' }`.
- A second `pc_complete_workflow` for a different workflow run on the same card also rejects.

`validating` is **not** a persisted status — it's a transient state inside `pc_complete_workflow` while predicates are being checked. The tool atomically transitions status on return.

## Invocation paths

Three ways a workflow starts. All converge on the same workflow run record.

### 1. Card-triggered

Card enters a node. Node has `on_enter`:

```json
{
  "id": "decompose-stage",
  "on_enter": {
    "workflow": "decompose-prd-to-jira",
    "inputs": {
      "prdText": "card.body",
      "jiraProject": "card.fields.project"
    },
    "outputs": {
      "createdStories": "card.fields.jiraStories"
    },
    "worktree": "auto"
  }
}
```

Runtime:
1. Card moves into `decompose-stage`, status → `in-progress`.
2. Evaluate `inputs` mapping against the card.
3. Ensure worktree (`auto` = create/reuse `card-<id>`).
4. Create workflow run with input + worktreePath.
5. POST channel event to orchestrator.
6. Orchestrator spawns subagent. Subagent runs. Calls `pc_complete_workflow`.
7. Output mapped to card fields per `outputs`. If `chain_to` set, runtime creates next workflow run.
8. When chain terminates (no further `chain_to`): card status → `pending` (or `complete` if at a terminal node with no further moves).

### 2. Orchestrator-triggered

Orchestrator decides ad-hoc: "I need research on X." Calls `pc_run_workflow({ name: 'research', input: {...} })`.

Runtime:
1. Validate input.
2. Create workflow run record.
3. Orchestrator spawns the workflow's subagent directly via Task.
4. Subagent runs. Calls `pc_complete_workflow`.
5. Output returned to orchestrator. No card update.

### 3. Workflow-chained

Workflow A completes with `chain_to: 'B'` (static) or output includes `next_workflow: 'B'` (dynamic).

Runtime:
1. Create workflow run for B with A's output as B's input.
2. POST channel event to orchestrator to spawn B's subagent.
3. Same flow as card-triggered from step 6.

## Chain mechanics

- **Static.** Workflow file has `chain_to: 'next-workflow-name'`. Always goes there on success.
- **Dynamic.** Subagent includes `next_workflow: '...'` in the output passed to `pc_complete_workflow`. Overrides static `chain_to`. Set to `null` to short-circuit.
- **Cycle / runaway protection.** Runtime tracks chain depth per root invocation. Max chain depth = 10. Exceeding cap → card status `blocked`, reason `chain depth exceeded`.

## Failure handling

Three failure modes the runtime watches for.

### Contract rejection loop

`pc_complete_workflow` returned `{ ok: false }`. Subagent retries inside the same Task.

- No hard cap inside the tool itself.
- Runtime counts rejections per workflow run.
- After **5 rejections**, runtime returns `{ ok: false, give_up: true, missing: [...] }`. Subagent should return after this; if it doesn't, the safety net catches it.
- After give-up: workflow run → `failed`, card → `blocked`. UI shows last rejection reason.

### Safety net: subagent returns without calling `pc_complete_workflow`

The contract is honor-system if the subagent never calls the tool. Runtime guard:

1. When subagent's Task returns, runtime checks: did `pc_complete_workflow` succeed for this workflow run?
2. If no → workflow run `failed`, card `blocked`. UI shows "Subagent returned without completing the workflow."

This is the actual enforcement. The system-prompt MUST-call instruction is documentation; the runtime guard is the gate.

### Worktree side effects

Files the subagent created stay in the worktree even if the contract fails. On retry, the subagent can finish them. On `blocked`, a human can inspect. On `failed` cleanup, the worktree is preserved by default — manual `pc_destroy_worktree` removes it.

## Calls I made (push back if wrong)

These are not decisions we worked through together — they're defaults I picked to keep the design complete. Worth a second look before implementation.

- **§A. Retry cap = 5.** Could be 3 or 10. Will surface in practice.
- **§B. Max chain depth = 10.** Same — picked a number.
- **§C. Card status enum = 5 states.** No persisted `validating`.
- **§D. `pc_update_card` demoted but not removed.** Available as admin tool. Hide via allowlists only if misuse appears.
- **§E. Worktree cleanup on failure: preserve.** Manual destroy.
- **§F. Safety net implementation.** Workflow run record carries a `completed_at` timestamp. Empty when subagent's Task returns → blocked.
- **§G. Orchestrator-triggered uses direct Task spawn, chained uses channel event.** Asymmetric. Could be unified through the channel at small latency cost. Flagged for implementation pass.
- **§H. Step instructions are free-text strings.** No structured step types (`tool-call`, `sub-workflow` as kinds). Add when a workflow demands it.

## Implementation order

Four slices fall out. Each ~1-2 sessions. Slice numbering skips 7 (reserved for multi-tenancy per BUILDOUT.md).

### Slice 6.5 — Contracts on the current workflow shape

- Add `done_when` to `workflow.json` node shape (interim — full new format lands in Slice 7).
- Add `pc_complete_workflow` MCP tool, scoped to single-node "workflows" (current rig shape).
- Update `researcher.md` system prompt: "Call pc_complete_workflow before returning."
- Update Slice 6's user test: enforce file write via contract.
- Add runtime safety net: check completion on Task return.

Validates the contract loop in the existing shape before the bigger refactor.

### Slice 8a — Vocabulary rename to PC parity

Mechanical rename pass (Card → WorkItem, kanban container → Project, etc. — full list in `BUILDOUT.md` Slice 8a). No new behavior; Slice 6.5 functionality carries forward under the new names. Sets the foundation for 8b's workflow runtime to land on PC-shaped types.

### Slice 8b — Workflow definition format + execution

- New `Workflow` callable type per this design, with the 2026-05-16 decision shifts (stage_id trigger only, inputs/outputs on workflow, hand-rolled validator, `subagent:` field as rig extension).
- YAML files at `workspace/.project-companion/workflows/*.yaml`.
- Workflow runtime spawns subagents with full workflow rendered into the Task prompt (steps list + rendered inputs).
- `pc_step_complete` for progress reporting.
- WorkItem-triggered invocation: stage_id match → fire workflow.
- WorkItem status field + locking (carried forward from 6.5 / 8a).
- `workflowYamlSnapshot` frozen at dispatch.

### Slice 9 — Chaining + orchestrator invocation

- Static `chain_to`.
- Dynamic `next_workflow` in output.
- Cycle / depth detection.
- `pc_run_workflow` MCP tool for orchestrator-triggered invocation.

### Slice 10 — UI

- Status pill on card.
- Workflow run progress (current step, last result).
- Contract checklist on card (predicates pass / fail).
- Blocked-card resolution UI.

## Resources

- `PLANNING-CONTRACTS-MODELS.md` — original questions and journey.
- `BUILDOUT.md` Session D log — empirical CC behavior we built on.
- `apps/server/src/services/workflow-runtime.ts` — current dispatch point. Grows into the workflow runtime described here.
- `packages/domain/src/{card,workflow}.ts` — types that extend per this design.
- `packages/mcp/src/server.ts` — where the three new MCP tools land.
- `workspace/.claude/agents/researcher.md` — gets the "must call pc_complete_workflow" rule.
