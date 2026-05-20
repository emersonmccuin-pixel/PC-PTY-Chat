// Section 15.1 — Reproduce the --session-id failure mode.
//
// Spawns claude.exe via node-pty with PC's exact orchestrator arg set, once
// WITHOUT --session-id (control) and once WITH it (treatment). Captures all
// output, exit code, and the encoded-cwd JSONL dir contents.
//
// Run: node scripts/repro-session-id.mjs

import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const CLAUDE_EXE = process.env.CLAUDE_EXE ?? 'C:\\Users\\example\\.local\\bin\\claude.exe';
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const RUN_MS = 45_000;
const BANNER_REGEX = /Welcome\s*back|Tips\s*for\s*getting\s*started|What's\s*new|Try\s*"/i;

function encodeCwdForClaude(cwd) {
  return cwd.replace(/[^A-Za-z0-9._-]/g, '-');
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[>=()]/g, '');
}

function makeWorkspace(label) {
  const ts = Date.now();
  const dir = join(tmpdir(), `pc-sessid-repro-${label}-${ts}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  return dir;
}

function listJsonl(workspaceDir) {
  const encoded = encodeCwdForClaude(workspaceDir);
  const dir = join(CLAUDE_PROJECTS, encoded);
  if (!existsSync(dir)) return { dir, files: [] };
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const p = join(dir, n);
      const st = statSync(p);
      return { name: n, size: st.size, mtime: st.mtimeMs };
    });
  return { dir, files };
}

function spawnOnce({ label, withSessionId }) {
  return new Promise((res) => {
    const workspaceDir = makeWorkspace(label);
    const sessionId = withSessionId ? randomUUID() : null;
    const args = [
      '--dangerously-skip-permissions',
      '--model', 'opus',
      '--mcp-config', '.mcp.json',
      '--strict-mcp-config',
    ];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('--dangerously-load-development-channels', 'server:webhook');

    console.log(`\n========== ${label.toUpperCase()} ==========`);
    console.log('cwd:        ', workspaceDir);
    console.log('args:       ', args.join(' '));
    console.log('sessionId:  ', sessionId ?? '(none)');

    const startedAt = Date.now();
    let rawBuf = '';
    let exited = false;
    let exitInfo = null;

    let child;
    try {
      child = spawn(CLAUDE_EXE, args, {
        cwd: workspaceDir,
        env: { ...process.env, FORCE_COLOR: '0' },
        cols: 120,
        rows: 30,
      });
    } catch (err) {
      console.log('SPAWN-THREW:', err?.message ?? err);
      res({ label, workspaceDir, sessionId, spawnThrew: String(err) });
      return;
    }

    child.onData((data) => { rawBuf += data; });
    child.onExit(({ exitCode, signal }) => {
      exited = true;
      exitInfo = { exitCode, signal, atMs: Date.now() - startedAt };
    });

    // Auto-press: keep pressing Enter once per second while boot prompts
    // are visible and the banner hasn't appeared. Robust against the prompt
    // not being ready to receive Enter the first time we see the matching
    // text. Stops once we see the banner.
    const handles = { trustPresses: 0, channelPresses: 0, bannerSeen: false, firstBannerAt: 0 };
    const tickAutoPress = () => {
      if (exited) return;
      const clean = stripAnsi(rawBuf);
      if (!handles.bannerSeen && BANNER_REGEX.test(clean)) {
        handles.bannerSeen = true;
        handles.firstBannerAt = Date.now() - startedAt;
        return;
      }
      // Check the trailing 1500 chars to see what's CURRENTLY on-screen
      // (avoid matching a stale, dismissed prompt earlier in the buffer).
      const tail = clean.slice(-1500);
      const trustVisible = /Quick\s*safety\s*check/i.test(tail) ||
        /Yes,\s*I\s*trust\s*this\s*folder/i.test(tail);
      const channelVisible = /Loading\s*development\s*channels/i.test(tail) ||
        /I\s*am\s*using\s*this\s*for\s*local/i.test(tail);
      // Press once per tick while either prompt is visible
      if (trustVisible && handles.trustPresses < 8) {
        handles.trustPresses += 1;
        try { child.write('\r'); } catch {}
      } else if (channelVisible && handles.channelPresses < 8) {
        handles.channelPresses += 1;
        try { child.write('\r'); } catch {}
      }
    };
    const autoPressTimer = setInterval(tickAutoPress, 1000);

    setTimeout(() => {
      clearInterval(autoPressTimer);
      try { child.kill(); } catch {}
      // give it a tick to actually die
      setTimeout(() => {
        const cleanFull = stripAnsi(rawBuf);
        const jsonl = listJsonl(workspaceDir);
        console.log('---');
        console.log(`elapsed:    ${Date.now() - startedAt}ms`);
        console.log(`exited:     ${exited ? `yes (code=${exitInfo.exitCode}, signal=${exitInfo.signal}, atMs=${exitInfo.atMs})` : 'no (killed by us)'}`);
        console.log(`trust presses:   ${handles.trustPresses}`);
        console.log(`channel presses: ${handles.channelPresses}`);
        console.log(`banner seen:     ${handles.bannerSeen}${handles.bannerSeen ? ` (at ${handles.firstBannerAt}ms)` : ''}`);
        console.log(`rawBytes:   ${rawBuf.length}`);
        console.log(`jsonl-dir:  ${jsonl.dir}`);
        console.log(`jsonl-files (count=${jsonl.files.length}):`);
        for (const f of jsonl.files) {
          console.log(`  - ${f.name} (size=${f.size}, mtimeAge=${Date.now() - f.mtime}ms)`);
        }
        // If we passed --session-id, check whether the named JSONL exists
        if (sessionId) {
          const named = join(jsonl.dir, `${sessionId}.jsonl`);
          if (existsSync(named)) {
            console.log(`NAMED-JSONL: EXISTS (${statSync(named).size} bytes)`);
            // dump first 300 chars
            const txt = readFileSync(named, 'utf-8').slice(0, 400);
            console.log('NAMED-JSONL HEAD:', JSON.stringify(txt));
          } else {
            console.log(`NAMED-JSONL: MISSING — expected at ${named}`);
          }
        }
        console.log('--- TRANSCRIPT (stripped, last 2000 chars) ---');
        console.log(cleanFull.slice(-2000));
        console.log('========================================');
        // cleanup workspace
        try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
        res({ label, workspaceDir, sessionId, exited, exitInfo, jsonl, transcriptTail: cleanFull.slice(-2000), handles });
      }, 300);
    }, RUN_MS);
  });
}

(async () => {
  console.log('claude.exe:', CLAUDE_EXE);
  console.log('exists:', existsSync(CLAUDE_EXE));
  console.log('projectsDir:', CLAUDE_PROJECTS);

  const controlResult = await spawnOnce({ label: 'control', withSessionId: false });
  const treatmentResult = await spawnOnce({ label: 'treatment', withSessionId: true });

  console.log('\n========== SUMMARY ==========');
  console.log('control   exited?', controlResult.exited, controlResult.exitInfo);
  console.log('treatment exited?', treatmentResult.exited, treatmentResult.exitInfo);
  console.log('treatment sessionId:', treatmentResult.sessionId);
  console.log('treatment named JSONL created?',
    treatmentResult.sessionId &&
      treatmentResult.jsonl.files.some((f) => f.name === `${treatmentResult.sessionId}.jsonl`)
  );
  process.exit(0);
})();
