---
name: improve-prompt
description: Interview the user to redesign a PC pod's system prompt. Use when the user types `/improve-prompt`, optionally with a pod name (e.g. `/improve-prompt orchestrator`), or asks to "redesign", "rewrite", or "improve" a pod's prompt. Walks the user through a paced 6-phase interview and produces a revised prompt + changelog + test plan, ready to paste into source. Reusable across orchestrator and all six stock pods (researcher, writer, reviewer, planner, extractor, agent-designer) plus any custom pod in the DB.
---

# improve-prompt

A guided interview that improves one pod's system prompt. Grounded in Anthropic's "right altitude" principle (specific enough to steer, flexible enough to generalise), Lost-in-the-Middle attention findings, and the positive-framing rule. Not a rewrite-it-yourself loop — the user's judgment drives every cut and add.

## Operating rules

- **One question per turn.** Don't batch. Wait for the answer before the next question.
- **Plain English.** The user is non-technical. Never say "load-bearing instruction," "literal-mode regression," "negative framing." Translate: "this rule, does it actually fire for you? Or is it pulling weight?"
- **Trust but verify.** Quote the actual current prompt back at the user when discussing a section. Don't paraphrase your way into a misread.
- **Don't auto-write source.** Output the revised prompt as a markdown code block at the end. The user copies it into the file themselves. (Stock pods are seeded INSERT-IF-NOT-EXISTS — existing installs need a manual reseed or Pod-UI edit to pick up changes.)
- **Cap the interview at ~12–15 questions max.** If you're past that and not converging, pause and ask the user if they want to ship what you have and iterate, or keep going.

## Pod source-of-truth locations

When the user names a pod, find its current prompt here:

| Pod | Source file | Constant name |
|---|---|---|
| `orchestrator` | `apps/server/src/services/orchestrator-pod-content.ts` | `ORCHESTRATOR_PROMPT` |
| `researcher` | `apps/server/src/services/stock-pod-seed.ts` | `RESEARCHER_PROMPT` |
| `writer` | `apps/server/src/services/stock-pod-seed.ts` | `WRITER_PROMPT` |
| `reviewer` | `apps/server/src/services/stock-pod-seed.ts` | `REVIEWER_PROMPT` |
| `planner` | `apps/server/src/services/stock-pod-seed.ts` | `PLANNER_PROMPT` |
| `extractor` | `apps/server/src/services/stock-pod-seed.ts` | `EXTRACTOR_PROMPT` |
| `agent-designer` | `apps/server/src/services/stock-pod-seed.ts` | `AGENT_DESIGNER_PROMPT` |
| Custom pods | DB only — read via `pc_get_agent` (if MCP available) or via the Pod UI; updates go through `pc_update_agent_prompt` or Global Settings | n/a |

Also read the pod's `tools`, `model`, `effort`, and `description` from the same file (or from the row) — these are part of the contract and shape what should stay in the prompt vs. live elsewhere.

## Procedure

### Phase 1 — Orient (2 turns)

1. **If no pod name given as argument, ask:** "Which pod's prompt are we improving? (orchestrator / researcher / writer / reviewer / planner / extractor / agent-designer / a custom one)"
2. Read the source file. Read the full current prompt + the tool list + the description. Count rough length (lines, words).
3. **Summarise back in one short paragraph:** "`<name>` — currently ~N lines / ~N words. Its job per the description is: '<quote>'. It has these tools: [...]. The prompt is structured as: <list its top-level section headers>. Sound about right, or am I missing something the description doesn't capture?"

### Phase 2 — Surface pain (2-3 turns)

Ask one at a time, wait for each answer:

4. **"What's wrong with this pod right now?"** Press for concrete examples — "it did X when I expected Y." Vague answers don't survive into rules. If they can't think of anything specific, ask if they're improving it speculatively or in response to actual misbehaviour.
5. **"What does this pod do well that you want to keep?"** This is the don't-cut-load-bearing-stuff list.
6. *(Optional, only if they have more)* **"Anything else surprising / annoying / load-bearing you've noticed?"**

Capture answers as a short bullet list ("pain points" and "preserve").

### Phase 3 — Audit the existing prompt (3-5 turns, one section at a time)

Walk top-level sections in order. For each, run this micro-checklist silently in your head and surface only the issues worth asking about. Don't bring up sections that are clean.

For each rule that looks suspect, ask **one** of:

- **Derivable from tool descriptions?** "This rule says [paste]. Couldn't the tool description for `<tool>` carry this instead? Pulling it out of the prompt would let the rule travel with the tool." Anthropic explicitly recommends polishing tool descriptions over re-explaining in the system prompt.
- **Aggressive language?** "This says 'NEVER X' / 'CRITICAL: you MUST X'. Claude 4.x overtriggers on this kind of language. Do you remember it actually firing helpfully here, or could we soften to 'X' or 'Avoid X when…'?"
- **Negative framing → positive?** "Right now it says 'do NOT X'. Could we phrase it as 'do Y' instead? Same effect, fewer reverse-psychology risks."
- **Reason missing?** "This rule is here but the *why* isn't written down. Without the reason, Claude can't generalise it. What's the actual reason — an incident, a constraint, a preference?"
- **Mid-prompt loadbearer?** "This rule is buried in the middle of a long section. Models attend to start + end of long prompts more than middles. If this is genuinely critical, move it to the style block at the end (or the hard-rules block near the top). Worth keeping where it is?"
- **Edge-case-list dressed as a rule?** "This section is 10+ bullets of edge cases. Anthropic recommends 3-5 canonical examples over an exhaustive edge-case list. Could we cut to the 3 that matter and trust the model to generalise?"
- **Contradiction?** If you spotted one — "Section X says 'do Y'. Section Z says 'don't Y unless…'. Which one wins, and can we reconcile?"

After the walk, give the user a one-paragraph summary of proposed changes:
"Here's what I think changes: cutting [...]. Reframing [...]. Moving [...]. Adding reasons to [...]. Keeping [...] untouched. Want me to proceed, or adjust?"

Wait for explicit approval before Phase 4.

### Phase 4 — Gap-finding (1-2 turns)

7. **"Anything the pod should do that isn't written down anywhere?"** Behaviours the user assumes are obvious — usually they aren't.
8. **"Any reference material the pod might need at runtime — examples, style guides, lookups?"** Push these toward **knowledge docs**, not the prompt. Rule of thumb: >500 chars or "sometimes relevant" → knowledge, not prompt. (For `pc_create_knowledge` use, this is the same line `agent-designer` follows.)

### Phase 5 — Restructure (silent, then preview)

Reshape the prompt in this order (skip sections the pod doesn't need):

1. **Role** — one line. "You are the X for this project."
2. **Jobs** — 3-6 bullets. What this pod actually does, in product terms.
3. **Hard rules** — positive framing where possible. Each surviving rule has either an obvious-from-context reason or an inline "because: <why>".
4. **Tool surface** — concise. Reference the tools by name; don't re-explain what each tool does — that's the tool description's job. Note structural exclusions (tools deliberately not granted) only when the absence matters.
5. **Event handling** *(orchestrator/agents that consume channel events only)* — header-tag routing kept; per-kind handlers tightened.
6. **Examples** *(if any)* — 3-5 canonical, wrapped in `<example>` tags. Skip if the rules above are clear enough without.
7. **Style** — at the end. Lost-in-the-Middle says tail-of-prompt re-peaks attention; put any rule the user wants the model to *feel* across every reply here.

Sanity checks before showing the user:
- No contradictions between sections.
- No "CRITICAL" / "MUST" / "NEVER" unless you can defend each one with a specific failure mode.
- Every rule has a discernible reason (explicit or obvious from context).
- Total word count tracks the use case — agentic pods 1500-3500 words is a healthy range; specialist pods can be under 500.

### Phase 6 — Deliver

Output three blocks, in order:

**1. Revised prompt** — full text in a fenced markdown code block, ready to paste. Preserve the backtick-escaping pattern the source file uses (the source is a TS template literal — inline backticks need `\``).

**2. Changelog** — bullet list, terse. Format:
```
- CUT: <section / rule> — <one-line why>
- REFRAMED: <before> → <after> — <one-line why>
- MOVED: <rule> from <section> to <section> — <one-line why>
- ADDED: <new rule> — <one-line why>
- KEPT: <section> — verbatim
```

**3. Test plan** — 3-5 concrete behaviours to watch for in the next session. Example: "Watch for: does it stop trying to fire `Task` after the first user request? (Removed the explicit hard-rule; relies on tool absence + tool description now.)"

End with one line: "When you've pasted it in, restart `pnpm dev` and start a fresh PC chat session — existing seeded rows don't auto-update, so for stock pods you'll need to also delete the row in `agents` table and let the seed re-run, or hand-edit the row through the Pod UI when 17d lands. Custom pods update immediately via `pc_update_agent_prompt`."

## What this skill explicitly does NOT do

- Doesn't write to the source file. The user copies the output block. (Avoids surprise edits to seeded behaviour that already-installed instances won't pick up.)
- Doesn't auto-fire MCP updates against custom pods. If the user wants to apply a revised custom-pod prompt via `pc_update_agent_prompt`, they explicitly say so and the main session does it after seeing the diff.
- Doesn't redesign the pod's *job* — only its prompt. If the user wants to repurpose a pod, that's an `agent-designer` conversation (or a new pod), not this skill.
- Doesn't churn on style. Match the project's terse-CLAUDE.md voice. Don't reflow working text just to "polish" it.

## Research anchors (for the model running this skill)

The procedure above is grounded in:
- **Anthropic prompting best practices** — positive framing beats negative; provide reasons; soften aggressive language for 4.x; 3-5 canonical examples; XML / markdown headers for structure; cap rule density.
- **Anthropic "Effective context engineering for AI agents"** — "right altitude" between brittle decision trees and vague guidance; smallest set of high-signal tokens.
- **Anthropic "Writing tools for agents"** — push behaviour into tool descriptions, not the system prompt.
- **Lost in the Middle (Liu et al., TACL 2024)** — load-bearing rules belong at start or end, not middles of long prompts.
- **OpenAI GPT-5 prompting guide** — contradictions are the #1 failure; surface them explicitly during the audit.

When in doubt during the interview, fall back to these.
