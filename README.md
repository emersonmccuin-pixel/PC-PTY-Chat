# Project Companion

The power of Claude Code, made for project work — not just code.

> Work in progress. This doc is the positioning + concept layer; it evolves as we iterate. For build status see [docs/TRACKER.md](docs/TRACKER.md).

## What this is

A local-first app that puts Claude Code at the center of project work for people who don't write code for a living. Persistent project chat, a customizable kanban board, specialist agents, and workflows you can build by talking to Claude. All on your existing Claude subscription. No API key, no per-token billing.

## Who it's for

Knowledge workers who:

- Run projects, not pipelines
- Have tried Claude or ChatGPT for work and felt the gap between "smart chatbot" and "useful collaborator"
- Are tired of starting from scratch every conversation
- Don't write code, but want what developers have been getting from Claude Code

## Why this exists

Claude Code is the most capable AI tool available right now — but it was built for engineers, on engineering surfaces (terminals, repos, files). The real power isn't the code editing; it's the loop:

- Long-running, contextual sessions on a real project
- Specialist agents for specialized work
- Tools that let the model actually *do* things, not just describe them
- Workflows that codify how *you* work

Engineers have had this for a year. Everyone else has been stuck with chat windows.

**This is the implementation layer.** Same engine, wrapped in surfaces non-technical people already understand: projects, boards, conversations, repeatable processes.

## What it costs

Your existing Claude subscription. The app drives the `claude` CLI under the hood — same auth, same quota, no API meter.

---

## The building blocks

Five concepts. Each stands alone; together they compound.

### Projects

A project is a folder, a chat history, a board, a set of agents, and a set of workflows — bundled. Open one and everything is scoped to it. The conversation remembers where you left off. The board shows this project's work. The agents know this project's context.

As many as you want. Switching is one click.

### Chat

A persistent conversation with Claude, anchored to the project. Not a fresh chat window every time — the same thread you come back to tomorrow, next week, next quarter.

Claude can read the project's files, ask you questions, run workflows, dispatch agents, and update the board. You can interrupt, redirect, or drop in mid-thread.

### Work items (kanban)

Cards on a board, organized in stages you define. The stages aren't fixed — a content team's board looks nothing like a sales team's or a research team's. You set them up to match how *you* work.

Claude can read the board, add cards, move them, write up the details. You can do the same by clicking around. Same data, two surfaces.

### Agents

A specialist Claude — focused role, system prompt tuned for one job. A researcher that pulls from specific sources. A copy editor that knows your style guide. A project planner that asks the right questions.

Agents come from a library you build over time. You create new ones by chatting with Claude — "I want an agent that does X" — and edit them anytime. No prompt-engineering background required.

### Workflows

A saved sequence of steps — "do this, then this, then ask the user, then this." A recipe Claude follows.

The point: you don't write workflows in code. You build them by chatting. "I do this same five-step thing every Monday. Make a workflow." Claude builds it, you run it, you tweak it the same way.

---

## How they fit together

The pieces compose. A few shapes of real work:

> _Collaborative fill — placeholders until we settle on the strongest examples together._

- **Weekly project status.** A workflow pulls last week's completed cards, drafts a summary, drops it in chat for your review, files the final version where it belongs.
- **New initiative kickoff.** You chat with Claude about a new project → it asks scoping questions → produces a plan → seeds the board with cards → dispatches a research agent on the biggest unknown.
- **Recurring research.** A research agent runs on a schedule against your sources, files findings as cards, only pings you when something matters.

---

## Status

Active development. See [docs/TRACKER.md](docs/TRACKER.md) for what's being built and where each piece sits in the planning → building → testing arc.

## Getting started

_To be written once the install path is settled._ Tracked as the **Onboarding** section in [docs/TRACKER.md](docs/TRACKER.md).

## License

MIT. See [LICENSE](./LICENSE).
