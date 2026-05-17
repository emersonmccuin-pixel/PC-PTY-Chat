// End-to-end smoke for Section 0 phases 0b-0e. Posts a fresh session,
// connects to the per-project WS, sends prompts, and reports per-envelope
// counts + samples of jsonl-* events. Pure observation — no DB writes.
//
// Run with the dev server already up:
//   node scripts/test-jsonl-tailer.mjs <projectId> [prompt]

// Node 22+ has WebSocket built-in (`global.WebSocket`).

const PROJECT_ID = process.argv[2];
const PROMPT = process.argv[3] ?? 'Reply with exactly the four words: hello from the tailer';
if (!PROJECT_ID) {
  console.error('usage: node scripts/test-jsonl-tailer.mjs <projectId> [prompt]');
  process.exit(2);
}

const BASE = 'http://127.0.0.1:4040';

async function main() {
  // 1. Force a fresh OrchestratorSession so we test the discovery loop, not
  //    a stale resume path.
  const sessRes = await fetch(`${BASE}/api/projects/${PROJECT_ID}/sessions/new`, {
    method: 'POST',
  });
  const sessJson = await sessRes.json();
  if (!sessRes.ok || !sessJson.ok) {
    console.error('new-session failed:', sessRes.status, sessJson);
    process.exit(1);
  }
  console.log('fresh session:', sessJson.session?.id);

  // 2. Open the per-project WS.
  const ws = new WebSocket(`ws://127.0.0.1:4040/ws?projectId=${PROJECT_ID}`);
  const counts = {};
  const jsonlSamples = {};
  let firstUserSeen = false;
  let turnEndSeen = false;
  let bannerSeen = false;
  let stateReady = false;
  let lastJsonlAt = null;

  const send = (msg) => ws.send(JSON.stringify(msg));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ws never opened')), 5_000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timeout); reject(e); }, { once: true });
  });
  console.log('ws open');

  ws.addEventListener('message', (msg) => {
    let env;
    try { env = JSON.parse(typeof msg.data === 'string' ? msg.data : ''); } catch { return; }
    const key = env.type;
    counts[key] = (counts[key] ?? 0) + 1;
    // Verbose: log every non-raw envelope (raw is high-frequency PTY bytes).
    if (env.type !== 'raw') {
      const peek = JSON.stringify(env).slice(0, 200);
      console.log(`[${new Date().toISOString().slice(11, 23)}] ${peek}`);
    }
    if (env.type === 'state') {
      if (env.state === 'ready' && !bannerSeen) {
        bannerSeen = true;
        console.log('claude.exe ready — sending prompt');
        // Tiny delay so banner-trigger doesn't race the input.
        setTimeout(() => send({ type: 'send', text: PROMPT }), 250);
      }
      if (env.state === 'ready' && firstUserSeen) stateReady = true;
    }
    if (env.type === 'jsonl') {
      lastJsonlAt = Date.now();
      const ev = env.event;
      const kind = `jsonl:${ev?.kind ?? 'unknown'}`;
      counts[kind] = (counts[kind] ?? 0) + 1;
      if (!jsonlSamples[ev?.kind]) {
        const s = JSON.stringify(ev);
        jsonlSamples[ev?.kind] = s.length > 200 ? s.slice(0, 200) + '…' : s;
      }
      if (ev?.kind === 'jsonl-user') firstUserSeen = true;
      if (ev?.kind === 'jsonl-turn-end') turnEndSeen = true;
    }
    if (env.type === 'event') {
      const inner = env.event;
      const kind = `event:${inner?.kind ?? 'unknown'}`;
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  });

  // Wait up to 60s for turn-end (or stateReady as fallback).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (turnEndSeen) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // Give a final 1s drain so any trailing envelopes after turn-end land.
  await new Promise((r) => setTimeout(r, 1_000));

  console.log('\n--- counts ---');
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('\n--- jsonl samples ---');
  for (const [kind, sample] of Object.entries(jsonlSamples)) {
    console.log(`  ${kind}: ${sample}`);
  }
  console.log('\n--- gate ---');
  console.log('  turnEndSeen:', turnEndSeen);
  console.log('  firstUserSeen:', firstUserSeen);
  console.log('  stateReady:', stateReady);
  if (lastJsonlAt) console.log('  ms since last jsonl envelope:', Date.now() - lastJsonlAt);

  ws.close();
  process.exit(turnEndSeen ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
