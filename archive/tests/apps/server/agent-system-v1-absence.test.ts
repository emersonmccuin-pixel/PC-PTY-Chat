// Section 25 Phase E — drift test: v1 agent-system symbols must stay gone.
//
// Phase D ripped the v1 surface end-to-end; Phase E renamed the v2 suffixes to
// bare names. This test fails if any of the deleted v1 symbols, file paths, or
// MCP tool names creep back into the tracked source tree.
//
// The test reads `git ls-files` so generated / untracked / dist artifacts are
// excluded by definition; the trip-wire is on COMMITTED code only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Repo root: this test runs from apps/server, so two levels up.
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const TRACKED_FILES = execSync('git ls-files', {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
})
  .split('\n')
  .filter(Boolean);

// Only inspect first-class TypeScript / JS sources. Migrations + drizzle
// metadata + documentation stay frozen on purpose (they reference v1 history).
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cjs', '.mjs']);
const SOURCE_FILES = TRACKED_FILES.filter((f) => {
  const dot = f.lastIndexOf('.');
  if (dot < 0) return false;
  if (!SOURCE_EXTS.has(f.slice(dot))) return false;
  // Skip the test itself (it intentionally names the dead symbols below).
  if (f.endsWith('apps/server/test/agent-system-v1-absence.test.ts')) return false;
  // Skip Phase E throwaway helpers (deleted before commit).
  if (/^\.tmp-/.test(f)) return false;
  return true;
});

// Removed v1 modules + tools + MCP names + renamed agent-system v2 holdovers.
// Add to this list when a future phase retires another v1 hold-over. Note: this
// is specifically the AGENT-SYSTEM v2 surface (Section 25 Phase E rename).
// Section 19's workflow rebuild legitimately uses `V2` suffixes (WorkflowV2,
// fireV2Workflow, WorkflowV2Registry, etc.) — those are NOT in scope here.
const DEAD_SYMBOLS = [
  // v1 module file basenames.
  'agent-run-manager.ts',
  'agent-resume.ts',
  'agent-inbox-emit.ts',
  'instruction-deposit-service.ts',
  'subagent-spawner-v2.ts',
  'schema-v2.ts',
  'agent-runs-v2.ts',
  'pending-asks-v2.ts',
  'agent-inbox-v2.ts',
  'agent-v2.ts',
  // v1 MCP tool names (Section 24 + pre-Phase-D originals).
  'pc_check_in',
  'pc_invoke_agent_v2',
  'pc_continue_agent_v2',
  'pc_list_my_runs_v2',
  'pc_ask_orchestrator_v2',
  'pc_ask_user_v2',
  'pc_request_approval_v2',
  'pc_answer_pending_v2',
  // v1 in-memory symbol classes.
  'AgentRunManager',
  'instructionDeposits',
  'InstructionDepositRow',
  'PcCheckInInput',
  'PcCheckInResult',
  // Renamed agent-system v2 class / URL / resource names (Phase E).
  'JsonlTailerV2',
  'agent-pending-asks-v2',
  '/agents/v2/',
  '/agent-runs/v2/',
];

test('v1 agent-system symbols and modules stay deleted', () => {
  const offenders: Array<{ symbol: string; file: string; line: number }> = [];
  for (const symbol of DEAD_SYMBOLS) {
    for (const file of SOURCE_FILES) {
      const abs = join(REPO_ROOT, file);
      let content;
      try {
        content = readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (!content.includes(symbol)) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(symbol)) {
          offenders.push({ symbol, file, line: i + 1 });
          break; // one hit per file is enough to flag.
        }
      }
    }
  }
  if (offenders.length > 0) {
    const rendered = offenders
      .map((o) => `  ${o.symbol}: ${o.file}:${o.line}`)
      .join('\n');
    assert.fail(`v1 agent-system symbols leaked back into source:\n${rendered}`);
  }
});

// NOTE: an earlier "no V2 / v2 suffix anywhere" regex sweep was retired here
// once Section 19 (workflow rebuild) began introducing `WorkflowV2`,
// `fireV2Workflow`, etc. — those are intentional. The Phase-E agent-system
// rename is still enforced by DEAD_SYMBOLS above, which now includes the
// renamed agent-system V2 class / URL / resource names.
