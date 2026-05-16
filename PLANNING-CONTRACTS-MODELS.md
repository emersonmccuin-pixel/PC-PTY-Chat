# Planning: Completion Contracts + Workflow Models A/B

Fresh-session entry point. Read this cold to set up the next planning conversation.

## What this session is for

Design the next big rig slice: **completion contracts** + **workflow lifecycle Models A/B**. Both pieces. Implementation comes after — this session is design only. Land on:

1. Shape of `done_when` contracts (predicate types, validation location, retry policy).
2. Mechanics of Model A (one Task = entire workflow) and Model B (one Task = one node).
3. How contracts + models interact.
4. Implementation order across the rig packages.

Output: a written design that an implementation session can pick up without re-deriving.

## Read first (in order)

1. `BUILDOUT.md` — current build state. The Session D log entry at the bottom captures the CC capability map we validated. The Followups section has the brief version of what's below.
2. `apps/server/src/services/workflow-runtime.ts` — the current shape of dispatch. Contracts plug in here.
3. `packages/domain/src/{card,workflow}.ts` — current domain types. Contracts extend `Workflow`.
4. `packages/mcp/src/server.ts` — where new MCP tools land.

## Background

### What we built (Slice 6)

UI button → `/api/cards/move` → `WorkflowRuntime.moveCard` → if destination node has `on_enter`: create/reuse worktree, POST channel event to webhook → orchestrator delegates to named subagent in the bound worktree → subagent returns → orchestrator calls `pc_update_card` → card field populated.

**Validated end-to-end on 2026-05-16.** Real bugs found and fixed (channel sender allowlist, orphan-branch recovery). See Session D log.

### What we discovered (the gap)

The loop trusts the orchestrator and subagent to actually do the work. In the user-test, the prompt told the researcher to *write* `findings.md` inside the worktree. The researcher returned a one-paragraph summary instead. The orchestrator dutifully stamped the card with that summary via `pc_update_card`. Nothing on disk had changed. The card said "done." The actual contract — "produce findings.md" — was hand-waved away.

### What we learned about CC's primitives

- **Subagents are one-shot.** A `Task` call is the subagent's entire life. No persistent state across calls (other than what the card carries).
- **A subagent can use a tool, see the result, decide what to do.** That's how the contract loop works internally: subagent calls `pc_complete_step` → gets back "field empty" → fixes it → calls again → gets ok → returns.
- **Nested Task is blocked in CC v2.1.140.** Conductor pattern (Model C) doesn't work. Subagent with `tools: Task` exits with `totalToolUseCount: 0`. So workflow lifecycle has to live in either the orchestrator (Model B) or one subagent's single Task call (Model A).
- **Channels deliver to the orchestrator only.** We never tested mid-Task channel injection, but architecturally it'd queue and process after Task returns. For multi-step interactions with a running subagent, use pull-not-push: subagent polls MCP/files for new info.
- **Agent files are eager-loaded** at session start. Changing tools or system prompts mid-session has no effect.

## The contract concept

Each workflow node declares a `done_when` block: the predicates that must be true for the work to count as done. The runtime exposes a `pc_complete_step` MCP tool. The subagent **must** call it before returning. The tool validates the proof against the contract; if anything's missing, it returns a structured rejection ("field 'summary' is empty, file 'findings.md' not found at path"). The subagent reads the rejection inside its same Task call, fixes the gap, calls again. When everything passes, the tool persists the result to the card and returns ok.

The orchestrator stays simple — it sees the subagent return, glances at the card to confirm `status === 'complete'`, and moves on. Or it never calls `pc_update_card` directly anymore at all; `pc_complete_step` subsumes it.

The contract belongs to the workflow node, not to the subagent. Different workflows can use the same researcher subagent with different contracts.

## Workflow lifecycle models

### Model A — one Task = full workflow run

Orchestrator spawns ONE Task. The subagent's system prompt names the workflow it's running. Inside that one Task:

- Subagent works on node 1's contract.
- Calls `pc_complete_step` with proof. Validation passes. Tool persists results, advances card to node 2.
- Subagent reads node 2's contract (via an MCP tool or from the channel event that fired Task), works on it.
- ... and so on until the terminal node.
- Subagent returns to orchestrator.

**One subagent identity for the whole run.** State lives in the subagent's conversation context. Reviews / approvals can happen at each `pc_complete_step` call by having the tool block on human input (UI button) before returning.

**Best for:** tight, single-specialist workflows. Draft → review → publish done by one writer agent.

**Worst for:** long workflows (context blow), multi-specialist workflows (one identity can't be many roles), pause/resume across sessions (Task dies with the orchestrator).

### Model B — one Task = one node

Orchestrator spawns a fresh Task per node. State carried on the card. Each Task:

- Reads card state (passed in prompt or read via MCP).
- Works on this node's contract.
- Calls `pc_complete_step`. Returns.

Orchestrator (or the workflow runtime watching for `pc_complete_step` success) advances the card to the next node, which fires that node's `on_enter`, which spawns the next Task. Different nodes can use different subagents.

**Best for:** long workflows, multi-specialist sequences, anything that needs to survive session restarts.

**Worst for:** chatty workflows (token cost per handoff), the "feels like one agent doing the work" pattern.

### The mix

User confirmed PC will run BOTH. Pick per workflow definition. Probably a `lifecycle: 'single-task' | 'per-node'` field on the workflow.

## Open questions to settle in the planning session

Each one needs a concrete decision before implementation.

### Contracts

1. **Predicate types.** Just `files-exist` + `fields-non-empty`? Or also `string-contains`, `custom-script`, `regex-match`? My take: start with the two simple ones, add others later if a real workflow needs them.

2. **Validation location.** Inside `pc_complete_step` only (subagent retries mid-turn)? Or also server-side after `pc_update_card` (defense in depth)? My take: just `pc_complete_step`. Don't validate in two places — leads to drift.

3. **Retry policy.** When `pc_complete_step` rejects, the subagent re-attempts inside its same Task. Is there a max attempts? My take: no hard cap from the tool — let the subagent's own context budget impose it naturally. But log every rejection in card history so we can see loops.

4. **Backward compat with `pc_update_card`.** Does it survive? Get deprecated? Get hidden from orchestrator (only `pc_complete_step` callable inside subagents)? My take: `pc_complete_step` subsumes the use case. Keep `pc_update_card` as a low-level admin tool but not part of the workflow contract path.

5. **Locked card during contract loop.** If the subagent is mid-fix, should other moves on the card be blocked? My take: yes — card has a `status` field, contract evaluation sets it to `validating`, other endpoints reject during that window.

### Model A

6. **How does the subagent advance between nodes inside one Task?** Options: (a) `pc_complete_step` itself advances (it knows the workflow), (b) separate `pc_advance_node` call after `pc_complete_step` ok, (c) `pc_complete_step` returns the next node's contract in its success payload. My take: (c) — simplest for the subagent, one tool call per phase transition.

7. **Where does the subagent read the workflow definition from?** Embedded in the channel event? Fetched via MCP at Task start? My take: passed in the Task prompt as a serialized workflow, so the subagent has it in context from token 1.

8. **What's the channel event for?** In Model A, the orchestrator spawns Task directly — do we still POST to the channel, or skip it? My take: skip the channel for Model A; channels are a Model B / external-trigger pattern.

### Model B

9. **Who triggers the next node's Task after `pc_complete_step` passes?** Server-side, the workflow runtime watches for ok responses and fires the next `on_enter` (which re-POSTs to channel). My take: yes, server-side in `WorkflowRuntime`. The orchestrator just reacts to channel events; it doesn't poll for completed steps.

10. **Resumable across sessions?** Model B's whole pitch is durability. Confirm we want this — implies card state is the only thing needed to resume; the orchestrator can re-fire a workflow on next boot. My take: yes, this is the win — bake it in.

11. **One subagent per node vs. specialist mapping.** Does the node declare its subagent (current shape), or does the workflow declare a role-to-subagent map at the top? My take: keep it on the node — simpler, matches current shape.

### State machine for cards

12. **Card status field.** New `status` enum on Card: `pending` (at a node, no Task running), `in-progress` (Task running for current node), `blocked` (contract failed, awaiting review), `complete` (terminal node), `failed` (gave up). My take: yes, add this. UI surfaces it as a state pill.

13. **Card history.** Already exists. Add entries for `contract-check-passed`, `contract-check-failed` with the failure reasons.

### UI

14. **Contract editor or read-only?** Workflow.json hand-edited for the rig (matches Slice 6 pattern). PC will need a real editor eventually. My take: rig stays JSON. Defer editor to PC.

15. **Visible contract progress.** Each card shows which contract predicates have passed / failed live. My take: yes, a checklist under the card title showing `findings.md ✓ / lastResult ✗`.

## Implementation order (proposed)

Once the design lands, the slices fall out as:

1. **Slice 6.5 — Completion contracts (works in current Slice 6 shape).** Add `done_when` to workflow nodes, add `pc_complete_step` MCP tool, update Slice 6's user-test to enforce file write. Rejection loop validated.
2. **Slice 8 — Model A workflow walker.** Single-Task subagent walks node sequence, calls `pc_complete_step` between phases. New `lifecycle: 'single-task'` field on workflow.
3. **Slice 9 — Model B per-node Tasks.** Orchestrator coordinates per node. New `lifecycle: 'per-node'` field. Existing channel/dispatch path basically already supports this — the change is `pc_complete_step` triggering the next node instead of waiting for `pc_update_card`.
4. **Slice 10 — Status field + UI.** Card status enum, contract-progress UI, "blocked" pill.

Each is plausibly 1-2 sessions.

## What's NOT in this planning session

- Slice 7 (multi-tenancy). Not blocked, but lower priority than contracts/models.
- Chat doubling investigation. Park.
- Session restart UX. Park.
- Port to PC proper (Phase 9-B). After the rig settles on contracts + models.

## Resources

- `BUILDOUT.md` Session log — empirical CC behavior we've validated.
- `apps/server/src/services/workflow-runtime.ts` — the dispatch point.
- `packages/domain/src/{card,workflow}.ts` — types to extend.
- `packages/mcp/src/server.ts` — where new MCP tools land.
- `workspace/CLAUDE.md` — orchestrator instructions; gets new section for contract handling.
- `workspace/.claude/agents/researcher.md` — subagent system prompt; gets the "must call pc_complete_step before returning" rule.
