# Session Q user test — Playwright handoff

Cold-read this top to bottom. You are a fresh Claude session being asked to verify Session Q (UI vendor + multi-tenant shell) end-to-end via Playwright against a live Project Companion dev stack. The user already shipped Q1–Q14; your job is to drive the browser and confirm the UI works.

## What this is testing

Project Companion v2 trunk, Session Q milestones Q5/Q8/Q9/Q10/Q11/Q12/Q13. The reference test plan is in `BUILDOUT.md` § "Session Q — UI vendor + multi-tenant shell" (the `> **User test.**` block ending with `- [ ] User test passed`). This document is the operational handoff that maps that plan to concrete Playwright actions.

## Environment — verify before you start

| Component | URL / location | How to verify |
|---|---|---|
| Hono dev server | `http://127.0.0.1:4040/` | `curl -s http://127.0.0.1:4040/api/projects` returns JSON with `projects` array |
| Vite dev server | `http://127.0.0.1:5173/` | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/` returns `200` |
| Channel server | `http://127.0.0.1:8788/channel/<slug>/<source>` | POST returns 200 with `X-Sender` header |
| Prod bundle | `http://127.0.0.1:4040/` (Hono serves `apps/web/dist/`) | Same HTML as dev once you `pnpm --filter @pc/web build` |

If any of these don't respond, the prior session left them down. Boot order:

```powershell
# In E:\Projects\Caisson
pnpm dev                          # terminal 1 — starts Hono on :4040 + channel server on :8788
pnpm --filter @pc/web dev         # terminal 2 — Vite on :5173
pnpm --filter @pc/web build       # one-shot — produces apps/web/dist/ for the prod URL test
```

If a port is already in use, find the PID and stop it:

```powershell
$conns = Get-NetTCPConnection -LocalPort 4040 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force }
```

## Test fixtures already prepared on disk

- `E:\temp\pc-q14-test\empty-folder` — empty directory for the `init-empty` create flow
- `E:\temp\pc-q14-test\folder-with-files` — has `README.md`, `notes.txt`, `src/index.js`; no `.git`; for the `init-in-place` flow

A pre-existing test project may already be in the DB at `E:\temp\pc-p-test\project-b` from earlier manual smoke tests. Treat it as immaterial — your tests should not depend on its presence or absence.

## Playwright setup

Use Playwright MCP if available; otherwise `@playwright/test` directly. The app runs at `http://127.0.0.1:5173/` (dev) and `http://127.0.0.1:4040/` (prod). Run the test suite against dev first, then re-run the critical path against prod.

Set `await page.goto('http://127.0.0.1:5173/');` and wait for `text=PROJECT COMPANION` to confirm the shell rendered.

### Helpful escape hatch: drive the backend via fetch when the UI is awkward

The FolderBrowserModal is click-only (no path input field) — to point it at `E:\temp\pc-q14-test\empty-folder` you'd have to traverse from `~/Projects` to the drive root and back down through `E:\temp\…`. That's brittle.

**Recommended:** first PATCH `projectsFolder` to `E:\temp\pc-q14-test` so the picker opens there directly:

```js
await page.request.patch('http://127.0.0.1:4040/api/settings', {
  data: { projectsFolder: 'E:\\temp\\pc-q14-test' },
});
await page.reload();
```

For any flow where the UI is awkward, **API-then-verify-UI** is acceptable: hit the endpoint, then assert the UI reflects the change via WS. The pure UI flow (clicking through) is also worth one pass at the end.

## DOM locator cheat sheet

These are the load-bearing locators. All come from current source (`apps/web/src/components/`).

### Header (`App.tsx`)
- App title: `text=PROJECT COMPANION`
- WS status pill: `text=/^ws: (idle|connecting…|live|disconnected)$/`
- Settings gear: `[aria-label="App settings"]`
- Activity panel toggle: `[aria-label="Toggle activity panel"]`

### Project rail (`ProjectRail.tsx`)
- Section header: `text=Projects`
- Empty state: `text=No projects yet.`
- Project button: `button:has-text("<project name>")` — also has `title=<folderPath>`
- New project button: `text=+ New project`

### Tabs (`Tabs.tsx`)
- Tab buttons: `button:has-text("Orchestrator")`, `button:has-text("Work items")`, `button:has-text("Workflows")`
- Project settings gear (right-aligned in tab strip): `[aria-label="Project settings"]`

### Create project modal (`CreateProjectModal.tsx`)
- Header: `text=Create project`
- Close button: `[aria-label="Close"]`
- Name input: `input[placeholder="My project"]`
- Browse button: `text=Browse…`
- Probe preview strings:
  - `text=Empty folder — will git init here and commit the scaffold.`
  - `text=/^\d+ existing entr(y|ies), no \.git/`
  - `text=Already a git repo — cannot create a project here.`
- Submit: `button:has-text("Create")`
- Cancel: `button:has-text("Cancel")`

### Folder browser modal (`FolderBrowserModal.tsx`)
- Header: `text=Choose folder`
- Parent (`↑`): `[title="Parent directory"]`
- Path display: the `<code>` showing current `view.path`
- Entry click = drill in. Entry double-click OR `text=Select this folder` button = select the current path.
- Cancel: `button:has-text("Cancel")`

### App settings modal (`AppSettingsModal.tsx`)
- Header: `text=App settings`
- Browse for projectsFolder: `button:has-text("Browse…")`
- Telemetry toggle label: `text=Enable telemetry`
- Data dir input: type `[type="text"]` adjacent to label `Data dir`
- Restart banner (after data-dir edit): `text=Restart required for data-dir change to take effect.`
- Save: `button:has-text("Save")`
- Cancel: `button:has-text("Cancel")`

### Project settings panel (`ProjectSettingsPanel.tsx`)
- Section titles: `text=Project info`, `text=Agents`, `text=Danger zone`
- Name input: the first `<input type="text">` under "Project info"
- Git remote input: `input[placeholder="git@github.com:org/repo.git"]`
- Save (project info): `button:has-text("Save")`
- Discard: `button:has-text("Discard")`
- Agent row edit: `button:has-text("Edit")` per row
- Add-from-library: `<select>` element under "Add from library" + `button:has-text("Add")`
- Agent editor textarea: the only `<textarea>` once an agent is being edited
- Save project copy: `button:has-text("Save project copy")`
- Library name input: `input[placeholder*="new-library-agent"]` (or the input adjacent to "Save as new library agent" button)
- Save as new library agent: `button:has-text("Save as new library agent")`
- Soft-delete: `button:has-text("Soft-delete…")` → confirm with `button:has-text("Confirm soft-delete")`
- Delete files: `button:has-text("Delete files…")` → `button:has-text("Confirm delete files")`

### Activity panel (`ActivityPanel.tsx`)
- Section title: `text=Activity`
- All-projects toggle: `button:has-text("All")` (background flips `primary/20` when active)
- Hide: `[aria-label="Hide activity panel"]`
- Status text: `text=/^(idle|connecting…|live|disconnected)$/` in the panel header
- Event rows: `<li>` children of the `<ul>` inside the scroll region
- Per-row: time `HH:MM:SS`, slug pill (only when `showAllProjects`), event-kind pill, summary

### Kanban (`KanbanBoard.tsx`)
- New card input placeholder: `input[placeholder="Card title"]`
- Cards are draggable via `@dnd-kit/core` — Playwright DnD: `await card.dragTo(targetColumn)`. Confirm via:
  - WS event `work-items-changed` on the connected client (visible in ActivityPanel)
  - API: `curl http://127.0.0.1:4040/api/projects/<id>/work-items`

## Test checklist — execute in order

For each item: write a Playwright `test(...)` (or `await expect(...)` chain), run, capture pass/fail with a one-line note.

### A. Cold boot + empty state (skip if a project exists)

A.1. `GET /api/projects` returns `{ projects: [] }`. If not, run `Stop-Process` on the Hono PID, `rm data/state.db*`, restart `pnpm dev`, reload Vite tab.

A.2. UI shows `text=No projects yet.` in the rail and `text=Create a project to get started.` in the center.

### B. Create empty-folder project (Q5 init-empty)

B.1. PATCH projectsFolder to `E:\temp\pc-q14-test` (see escape hatch above) and reload.

B.2. Click `+ New project`. Modal opens with header `Create project`.

B.3. Fill name `Q14 Project A`. Click `Browse…`. The folder picker should open at `E:\temp\pc-q14-test`. Double-click the `empty-folder` row.

B.4. The probe preview reads `Empty folder — will git init here and commit the scaffold.`

B.5. Click `Create`. The modal closes. `Q14 Project A` appears in the rail and is auto-selected. Center shows empty kanban (`Work items` tab) and empty chat (`Orchestrator` tab).

B.6. Verify on disk via `git -C E:\temp\pc-q14-test\empty-folder log --oneline`: exactly one commit titled `Initial commit`. The folder now contains `.git/`, `.claude/`, `.project-companion/`, `README.md`, `.mcp.json`.

### C. Create in-place project (Q5 init-in-place)

C.1. `+ New project` again. Name `Q14 Project C`. Browse to `folder-with-files`.

C.2. Probe preview reads `3 existing entries, no .git — will commit as Initial import then add scaffold.`

C.3. Click `Create`. `Q14 Project C` lands in the rail.

C.4. `git -C E:\temp\pc-q14-test\folder-with-files log --oneline` shows TWO commits: `Add Project Companion scaffold` and `Initial import` (newest first). The original files (`README.md`, `notes.txt`, `src/index.js`) survive.

### D. Probe rejection (server refuses re-init)

D.1. `+ New project`. Browse to `folder-with-files` again. Probe preview reads `Already a git repo — cannot create a project here.` Create button stays disabled.

D.2. Cancel the modal.

### E. Project switching (Q4/Q6 active-project plumbing)

E.1. Click `Q14 Project A` in the rail. Tab strip is visible; Orchestrator + Work items + Workflows + gear all present.

E.2. Switch to Project C. Workspace re-keys: kanban empty for C (or whatever C's state is), workflows panel empty, chat panel empty. Zero events from A bleeding through.

E.3. Reload the page. The persisted active project (zustand-backed via localStorage) should re-select C.

### F. Kanban DnD (Q7)

F.1. On Project A, `Work items` tab. Type `First card` in the `Card title` input under the leftmost column. Submit.

F.2. Card appears immediately (optimistic) and `work-items-changed` shows in the activity panel.

F.3. Drag the card to the next column. After drop:
  - The card is in the new column.
  - `curl http://127.0.0.1:4040/api/projects/<A.id>/work-items` shows it at the new `stageId`.
  - Activity panel shows `work-item moved: First card`.

F.4. Repeat for Project C. Confirm no event with C's projectId appears while A is active and `All` is off.

### G. Channel events (Q3 path-routed)

G.1. POST a channel event to A:

```bash
curl -X POST http://127.0.0.1:8788/channel/q14-project-a/webhook \
  -H "X-Sender: test" \
  -d "ping from playwright"
```

G.2. While A is active in the UI: Activity panel shows a `channel` row labeled `webhook: ping from playwright`. Orchestrator chat (if you're on that tab) shows a channel bubble (Q8).

G.3. With A active and `All` toggle OFF, POST a channel event to C. The activity panel does NOT show it.

G.4. Click `All` (highlights primary). The activity panel header pill stays primary across reload. POST another channel event to C. Now it shows with a `Q14-PROJECT-C` slug pill.

### H. Project settings — info + agents (Q11)

H.1. On Project A, click the project-settings gear in the tab strip (right side, `aria-label="Project settings"`). ProjectSettingsPanel renders.

H.2. Sections visible: `Project info`, `Agents`, `Danger zone`. Slug field shows `q14-project-a` (locked).

H.3. Edit name to `Q14 Project A renamed`. Save. Rail label updates without reload. `GET /api/projects` confirms.

H.4. Set git remote to `git@github.com:test/repo.git`. Save. Reload page — field still populated.

H.5. Agents section: should list any agents copied during project create (`researcher` typically). Click `Edit` on `researcher`. Textarea appears with the body.

H.6. Edit the body (add `# test edit` at the top). Click `Save project copy`. Note `Project copy updated.` appears.

H.7. `cat E:\temp\pc-q14-test\empty-folder\.claude\agents\researcher.md` — first line shows `# test edit`.

H.8. `curl http://127.0.0.1:4040/api/agents` — verify the **library** `researcher.md` is unchanged (no `# test edit`).

H.9. In the editor, change the library name suggestion to `researcher-q14-fork`. Click `Save as new library agent`. Note `Saved to library as "researcher-q14-fork".` appears. Verify via `curl http://127.0.0.1:4040/api/agents`.

H.10. Close editor. Dropdown "Add from library" now lists `researcher-q14-fork`. Add it to Project A. New row appears.

### I. Danger zone (Q11)

I.1. Project settings → Soft-delete. First click reveals `Confirm soft-delete` + Cancel. Click Confirm.

I.2. Project A disappears from the rail. `GET /api/projects` no longer lists it. `GET /api/projects?include_deleted=1` shows `deleted_at: <ms>`.

I.3. Folder + files still on disk: `dir E:\temp\pc-q14-test\empty-folder` shows everything intact including `.claude/`, `.project-companion/`.

I.4. Soft-delete is independent of file removal: navigate to Project C settings, click `Delete files…` → `Confirm delete files`. Note returned: `Removed: .project-companion, .claude`.

I.5. On disk: `dir E:\temp\pc-q14-test\folder-with-files`. `.project-companion` + `.claude` are gone. `.git`, `README.md`, `notes.txt`, `src/`, `.mcp.json` survive.

### J. App settings (Q10)

J.1. Click the gear icon (header, `aria-label="App settings"`). Modal opens.

J.2. Toggle telemetry on. Save. No restart banner. Re-open settings — telemetry still on.

J.3. Edit Data dir to a different absolute path (`E:\temp\pc-q14-data-test`). The inline warning `Restart required for data-dir change to take effect.` appears. Save.

J.4. After modal closes, the page-level banner `Data-dir change saved — restart the server for it to take effect.` shows above the shell. Click `dismiss` — it goes away.

J.5. Revert the data dir to the original value (e.g. `E:\Projects\Caisson\data`) and save so the next test step doesn't hit a fresh DB.

### K. Activity panel persistence (Q12)

K.1. Click the toggle button to hide the panel. Reload. Panel still hidden (state lives in `settings.activityPanel.open`).

K.2. Click to re-open. Toggle `All`. Reload. Both states persist.

### L. WS reconnect + dedup (Q13)

L.1. With UI open and `ws: live` showing, stop Hono:

```powershell
$pids = (Get-NetTCPConnection -LocalPort 4040 -State Listen).OwningProcess
foreach ($p in $pids) { Stop-Process -Id $p -Force }
```

L.2. UI header flips to `ws: disconnected` within ~1 second. Within the next 2s the hook attempts a reconnect (backoff: 2s, then 5s, then 15s, then 30s cap).

L.3. Restart Hono (`pnpm dev` in the original directory). Within the next backoff window the UI flips to `ws: live` **without a page reload**.

L.4. After reconnect, scroll the Orchestrator chat (switch tab if needed). Verify no duplicate bubbles. The server replays `events.jsonl` on every WS connect; Q13 dedup uses the event `ts` field.

L.5. (Optional) Repeat the stop/start cycle 2–3 times rapidly to confirm the backoff doesn't accidentally cap at 30s permanently (it should reset to 2s on each successful open).

### M. Prod URL

M.1. Open `http://127.0.0.1:4040/` in a fresh tab. Repeat steps E and F (switching + DnD). Everything works the same.

M.2. If Hono fails to serve the JS bundle, run `pnpm --filter @pc/web build` first. The Hono server reads `apps/web/dist/` on startup.

## Final reporting format

Produce a pass/fail table:

```
| Step | Pass | Notes |
|---|---|---|
| A.1 | ✅ |  |
| A.2 | ✅ |  |
| B.1 | ✅ |  |
…
| L.5 | ⏭ | optional, skipped |
| M.1 | ✅ |  |
```

For any FAIL, capture:
1. The step ID
2. What you saw vs. what was expected
3. A screenshot path (`await page.screenshot({ path: 'fail-B5.png' })`)
4. The relevant console + network errors (`page.on('console', …)`, `page.on('requestfailed', …)`)

After running the suite, tick the `- [ ] User test passed` checkbox at the end of the Session Q block in `BUILDOUT.md` if everything passed. If anything failed, leave it unticked and append a note to the second Session Q mid-session log entry summarizing the gap.

## Gotchas the prior session hit

- The harness LSP cache frequently goes stale after edits — diagnostics that complain about deleted/renamed identifiers usually clear after a real `pnpm -r typecheck`. Trust typecheck output over the IDE squiggles.
- The trunk server's WS layer supersedes prior subscribers for a given `projectId` (`apps/server/src/index.ts:780`). Do not open a second WS for the active project from the same browser tab — `useAllProjectsWs` already excludes the active project for this reason. If a Playwright test seems to lose events after opening multiple tabs against the same project, that's why.
- The `data.bak.*` dirs at the repo root are untracked snapshots from earlier sessions; they're not part of the test surface.
- Channel server URL is `http://127.0.0.1:8788/channel/<slug>/<source>` — 8788, **not** 4040. Requires `X-Sender` header or the request is rejected.

## Code references for deeper digs

- Server endpoints in scope: `apps/server/src/index.ts` lines 200–520 (settings + projects + agents + work-items) and 760–870 (WS handler with subscriber supersede + events.jsonl replay).
- WS hooks: `apps/web/src/hooks/use-project-ws.ts` (single connection + backoff + dedup) and `apps/web/src/hooks/use-all-projects-ws.ts` (N parallel sockets, excludes active).
- Settings envelope: `packages/domain/src/settings.ts` defines `GlobalSettings` and `ActivityPanelSettings`.
- Test plan source of truth: `BUILDOUT.md` § "Session Q — UI vendor + multi-tenant shell" `> **User test.**` block (lines 520–530 in the current revision).
