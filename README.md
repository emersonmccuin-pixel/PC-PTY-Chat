# Project Companion

Build your own AI workflows by talking to Claude. No code. No prompt engineering. No terminal. No waiting.

---

## The problem

AI at work is gated by tech fluency.

The people who know what `CLAUDE.md` is, how to write a skill, how to wire up an MCP server — they get real leverage. They turn AI into a teammate that actually knows their job. Everyone else gets a chat window and starts over every conversation.

Engineers built that leverage for themselves a year ago. The rest of the org is still waiting their turn.

## What this is

A local app where anyone in your organization builds their own AI workflows by talking to Claude.

A real GUI — click, drag, type. No commands, no config files, no editing JSON. You describe what you do in plain English; Companion turns it into something repeatable: an agent with the right tools, the context it needs, your steps in the right order. You run it on demand. You tweak it the same way you built it.

You are the expert on how the work should be done. Companion captures your method so you stop redoing it from scratch every time.

## What it looks like in practice

**Data analyst.** You answer the same handful of questions every week — "how's funnel conversion trending," "which channels are softening," "what broke in last night's run." Today that means re-explaining to Claude where the data lives, what your semantic layer is, what "active user" actually means in your warehouse.

In Companion you build a **pod**. It holds the credentials, the schema, an example query, the semantic-layer rules — and the workflow that walks the agent through how you'd answer. Call the pod. The answer comes back built the way you'd build it, every time.

**Sales follow-up.** After every customer call you do the same thing: pull the Gong transcript, read it for questions and concerns, line them up against your product's answers, write a follow-up email in your voice.

In Companion this is a pod too. The product context, your voice samples, your standard answers to common objections — bundled with the workflow that does the pulling, parsing, matching, and drafting. You ship the email twenty minutes after the call instead of two days later, and it sounds like you wrote it.

## How it works

Five pieces. You build them all by chatting.

- **Projects** scope the work. One per initiative, with its own chat, board, pods, and agents.
- **Pods** are the repeatable engine. A bundle of a workflow plus everything it needs to run — context, credentials, files, the agent that does the job. Lives in its own tab. Built once, run forever.
- **Workflows** are the steps. A repeatable sequence — what runs when, in what order, with what tools. Lives inside a pod for repeatable work, or runs free from chat for one-offs.
- **Agents** are your library of specialists. A data analyst, a researcher, a copy editor — each tuned for one role, each with its own tools.
- **Work items** are the kanban side. Cards moving through stages, for the day-to-day work that isn't yet a pod.

The chat is where you build and run. The board surfaces what's in flight. The pods tab is the production line.

## Building a workflow

You don't need to know n8n. You don't need to know Zapier. You don't need to map a node graph, write a YAML config, or learn what a webhook is.

You have a conversation.

The chat has an interview tool that walks you through it:

- **What do you want it to do?**
- **What triggers it?** Moves to a stage on the board, called manually, on a schedule.
- **What has to happen?** The steps, in your words.
- **What secrets does it need?** API keys, credentials, logins to anything it has to reach.
- **What does review look like?** Draft for your approval, auto-send, file as a card, ping someone for sign-off.
- **What's the expected output?** An email, a report, a Slack message, a row in a sheet, a new card on the board.

You answer in plain English. Companion writes the workflow. You run it. If something needs to change, you tell it — same chat, same conversation — and it adjusts.

The person who knows how the job should be done is finally the one operating the tool. No translator, no specialist, no waiting.

## What it costs

Your existing Claude subscription. Companion uses it directly — same login, same plan, no extra billing.

## License

MIT. See [LICENSE](./LICENSE).
