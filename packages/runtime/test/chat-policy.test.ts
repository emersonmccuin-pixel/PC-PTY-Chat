// Stage 0 guard for the JSONL-canonical chat refactor
// (docs/chat-canonical-source-redesign.md). The policy table is dormant — not
// yet wired into any render path — so the only thing that can regress is the
// table itself. Two invariants:
//   1. Exhaustive: every JsonlEvent kind has an explicit policy (no fallthrough).
//   2. Equivalent to today: rowPolicy().visibility === 'hidden' iff today's
//      pipeline suppressed the row (normalizeJsonlEnvelope `return null` +
//      toolGrouping SUPPRESSED_TOOLS). Visible-vs-collapsed loses no info;
//      only `hidden` gates whether a message reaches the user.
//
// Run via:  pnpm --filter @pc/runtime test

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { JsonlEvent } from '../src/jsonl-tailer.ts';
import { INTERNAL_TOOLS, rowPolicy } from '../src/chat-policy.ts';

// One representative event per kind, plus the conditional edge cases that today's
// pipeline branches on (turn-end text, usage speed/cache-miss, internal tools).
const FIXTURES: Array<{ label: string; ev: JsonlEvent }> = [
  { label: 'user', ev: { kind: 'jsonl-user', text: 'hi' } },
  { label: 'turn-end (text)', ev: { kind: 'jsonl-turn-end', text: 'done', stopReason: null } },
  { label: 'turn-end (empty)', ev: { kind: 'jsonl-turn-end', text: '', stopReason: null } },
  {
    label: 'tool-call (visible)',
    ev: { kind: 'jsonl-tool-call', toolUseId: 't1', name: 'Bash', input: {} },
  },
  {
    label: 'tool-call (internal)',
    ev: { kind: 'jsonl-tool-call', toolUseId: 't2', name: 'TodoWrite', input: {} },
  },
  {
    label: 'tool-result',
    ev: { kind: 'jsonl-tool-result', toolUseId: 't1', result: 'ok', isError: false },
  },
  {
    label: 'tool-progress',
    ev: {
      kind: 'jsonl-tool-progress',
      toolUseId: 't1',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedSeconds: 1,
      taskId: null,
      raw: {},
    },
  },
  {
    label: 'usage (standard)',
    ev: {
      kind: 'jsonl-usage',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: 'opus',
      speed: 'standard',
      cacheMissReason: null,
    },
  },
  {
    label: 'usage (non-standard speed)',
    ev: {
      kind: 'jsonl-usage',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: 'opus',
      speed: 'fast',
      cacheMissReason: null,
    },
  },
  {
    label: 'usage (cache miss)',
    ev: {
      kind: 'jsonl-usage',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: 'opus',
      speed: 'standard',
      cacheMissReason: 'expired',
    },
  },
  {
    label: 'system',
    ev: { kind: 'jsonl-system', subtype: 'api_error', level: 'error', message: 'x', timestamp: null, raw: {} },
  },
  {
    label: 'session-state',
    ev: { kind: 'jsonl-session-state', state: 'idle', permissionMode: null, timestamp: null, raw: {} },
  },
  {
    label: 'compact',
    ev: { kind: 'jsonl-compact', trigger: null, preTokens: null, messagesSummarized: null, timestamp: null, raw: {} },
  },
  {
    label: 'microcompact',
    ev: { kind: 'jsonl-microcompact', trigger: null, preTokens: null, tokensSaved: null, timestamp: null, raw: {} },
  },
  { label: 'queue-enqueue', ev: { kind: 'jsonl-queue-enqueue', timestamp: null } },
  { label: 'queue-dequeue', ev: { kind: 'jsonl-queue-dequeue', timestamp: null } },
  { label: 'ai-title', ev: { kind: 'jsonl-ai-title', title: 't' } },
  { label: 'last-prompt', ev: { kind: 'jsonl-last-prompt', uuid: null, raw: {} } },
  { label: 'file-history', ev: { kind: 'jsonl-file-history', snapshotId: null, raw: {} } },
  { label: 'bridge-session', ev: { kind: 'jsonl-bridge-session', bridgeSessionId: null, raw: {} } },
  { label: 'sidechain', ev: { kind: 'jsonl-sidechain', raw: {} } },
  {
    label: 'turn-duration',
    ev: { kind: 'jsonl-turn-duration', durationMs: null, budgetTokens: null, messageCount: null, timestamp: null, raw: {} },
  },
  {
    label: 'post-turn-summary',
    ev: {
      kind: 'jsonl-post-turn-summary',
      summarizesUuid: null,
      statusCategory: null,
      statusDetail: null,
      isNoteworthy: false,
      title: null,
      description: null,
      recentAction: null,
      needsAction: false,
      artifactUrls: null,
      timestamp: null,
      raw: {},
    },
  },
  {
    label: 'stream-event',
    ev: { kind: 'jsonl-stream-event', event: {}, parentToolUseId: null, raw: {} },
  },
];

/** Replica of today's suppression: a row is invisible in chat iff the old
 *  normalizeJsonlEnvelope returned null for it, OR toolGrouping's SUPPRESSED_TOOLS
 *  hid its tool-call. Kept verbatim so the equivalence assertion is meaningful. */
function suppressedToday(ev: JsonlEvent): boolean {
  switch (ev.kind) {
    case 'jsonl-turn-end':
      return !ev.text;
    case 'jsonl-tool-call':
      return INTERNAL_TOOLS.has(ev.name);
    case 'jsonl-usage':
      return (!ev.speed || ev.speed === 'standard') && !ev.cacheMissReason;
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
    case 'jsonl-ai-title':
    case 'jsonl-last-prompt':
    case 'jsonl-file-history':
    case 'jsonl-bridge-session':
    case 'jsonl-turn-duration':
    case 'jsonl-post-turn-summary':
    case 'jsonl-stream-event':
    case 'jsonl-sidechain':
      return true;
    default:
      return false;
  }
}

test('rowPolicy is exhaustive — every fixture kind yields a defined policy', () => {
  const seen = new Set<string>();
  for (const { ev } of FIXTURES) {
    const p = rowPolicy(ev);
    assert.ok(['shown', 'collapsed', 'hidden'].includes(p.visibility), `bad visibility for ${ev.kind}`);
    assert.ok(['chat', 'tools', 'system', 'internal'].includes(p.lane), `bad lane for ${ev.kind}`);
    seen.add(ev.kind);
  }
  // Pin coverage of the full union (update when a kind is added — the compile-time
  // `never` check in rowPolicy already forces a policy branch).
  assert.equal(seen.size, 20, 'fixture set drifted from the JsonlEvent kind union');
});

test('hidden set is exactly today’s suppressed set (no message silently dropped or newly shown)', () => {
  for (const { label, ev } of FIXTURES) {
    const isHidden = rowPolicy(ev).visibility === 'hidden';
    assert.equal(
      isHidden,
      suppressedToday(ev),
      `${label}: policy hidden=${isHidden} but today suppressed=${suppressedToday(ev)}`,
    );
  }
});

test('internal tools are hidden, ordinary tools are visible', () => {
  assert.equal(rowPolicy({ kind: 'jsonl-tool-call', toolUseId: 'a', name: 'TodoWrite', input: {} }).visibility, 'hidden');
  assert.notEqual(rowPolicy({ kind: 'jsonl-tool-call', toolUseId: 'b', name: 'Read', input: {} }).visibility, 'hidden');
});
