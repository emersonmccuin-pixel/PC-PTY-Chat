# Caisson

Build your own AI workflows by talking to Claude. No code. No prompt engineering. No terminal.

---

## The contract

> **Caisson** is a tool for a one-person operation — technical or not — to capture, automate, and run their repetitive work across multiple projects. The user lives in conversation with a project-specific **AI Project Manager**. Workflows are authored conversationally, not coded. They fire on schedule, on external events, on manual command, or on internal state changes. Each run produces a tree of tasks — some completed by AI specialists on the user's team, some by external systems via tool integrations, some held for human-in-the-loop review. Caisson's job is to make every repeatable process less work to run while keeping the user in control of the parts that need judgment.

Everything below is that sentence, unpacked.

## The problem it solves

AI at work is gated by tech fluency.

The people who know what `CLAUDE.md` is, how to write a skill, how to wire up an MCP server — they get real leverage. They turn AI into a teammate that actually knows their job. Everyone else gets a chat window and starts over every conversation.

Caisson closes that gap. You describe how the work should be done, in plain English, and Caisson turns it into something repeatable — captured once, run forever. The person who knows the job is finally the one operating the tool.

## Unpacking the contract

**"A one-person operation — technical or not."** The audience is a single operator running several initiatives — an SDR, an analyst, a founder, a fractional consultant, a solo dev. No team handoffs, no shared dev loop. Local-first, single-user by design.

**"Lives in conversation with a project-specific AI Project Manager."** Each project has its own chat with an orchestrator that knows that project's context, files, and history. This is the front door — not a kanban board, not a settings panel. You manage your day by talking to it.

**"Workflows are authored conversationally, not coded."** You don't map a node graph or write YAML. You have a conversation; Caisson writes the workflow. Change it the same way you built it.

**"They fire on schedule, on external events, on manual command, or on internal state changes."** Four triggers. A workflow can run every Monday, when an email lands, when you click "run," or when a task crosses a stage on the board.

**"Each run produces a tree of tasks."** A task is the universal primitive. A workflow run spawns a structured tree of them — the kanban board is just one view of that tree.

**"Some completed by AI specialists on the user's team."** You keep a roster of specialists — a data analyst, a researcher, a copy editor — each tuned for one role with its own tools and context. The Project Manager dispatches work to them.

**"Some by external systems via tool integrations, some held for human-in-the-loop review."** Steps can call out to external tools and services, and any step can pause for your approval. You stay in control of the parts that need judgment.

## What it looks like in practice

**Data analyst.** You answer the same handful of questions every week — "how's funnel conversion trending," "which channels are softening." Today that means re-explaining to Claude where the data lives, what your semantic layer is, what "active user" means in your warehouse.

In Caisson you capture it once: the credentials, the schema, an example query, the semantic-layer rules, and a workflow that walks a specialist through how you'd answer. Call it. The answer comes back built the way you'd build it, every time.

**Sales follow-up.** After every customer call you do the same thing: pull the transcript, read it for questions and concerns, line them up against your product's answers, write a follow-up email in your voice.

In Caisson that's a workflow too — product context, your voice samples, your standard answers to common objections, bundled with the steps that do the pulling, parsing, matching, and drafting. You ship the email twenty minutes after the call instead of two days later, and it sounds like you wrote it.

## How you build it

You have a conversation. The chat has an interview tool that walks you through it:

- **What do you want it to do?**
- **What triggers it?** A schedule, an external event, a manual click, or a task crossing a stage.
- **What has to happen?** The steps, in your words.
- **What secrets does it need?** API keys, credentials, logins to anything it has to reach.
- **What does review look like?** Draft for your approval, auto-send, file as a task, ping someone for sign-off.
- **What's the expected output?** An email, a report, a message, a row in a sheet, a new task on the board.

You answer in plain English. Caisson writes the workflow. You run it. If something needs to change, you tell it — same chat — and it adjusts.

**Specialists are built the same way.** An interview walks you through a specialist's purpose, what it should produce, where the output goes, which model and tools it needs, and a name. Plain English in, complete agent out. No YAML, no system prompt to hand-write.

## What it costs

Your existing Claude subscription. Caisson uses it directly — same login, same plan, no extra billing. It drives the interactive Claude CLI under the hood; there is no separate API key and no per-token charge.

## Developer setup

Prerequisites:

- Node 22
- pnpm 10.33.0
- Git
- Claude Code CLI, if you want to run the product locally end-to-end

Clone and verify:

```powershell
git clone https://github.com/emersonmccuin-pixel/Caisson.git
cd Caisson
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Run locally:

```powershell
pnpm dev
pnpm --filter @pc/web dev
```

The API/channel server runs on `http://127.0.0.1:4040` and `:8788`. The Vite frontend runs on `http://127.0.0.1:5173`.

## Desktop builds

Local package smoke:

```powershell
pnpm desktop:dist:dir
```

Installers:

```powershell
pnpm desktop:dist:win
pnpm desktop:dist:mac
```

Windows installers are built on Windows. macOS DMG/ZIP builds are built on macOS. GitHub Actions has separate workflows for package smoke and release installers. macOS release builds require Apple Developer signing and notarization secrets; Windows signing is optional but recommended before public distribution.

Archived docs, tests, CI metadata, and investigation utilities live under [archive](archive).
See [archive/docs/desktop-build.md](archive/docs/desktop-build.md) for the old GitHub Actions runbook and signing secret list.

## License

MIT. See [LICENSE](./LICENSE).
