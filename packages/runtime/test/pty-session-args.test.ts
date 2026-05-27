import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPtySessionArgs, type PtySessionOptions } from '../src/pty-session.ts';

function baseOptions(): PtySessionOptions {
  const dir = mkdtempSync(join(tmpdir(), 'pc-pty-session-args-'));
  return {
    workspaceDir: dir,
    stopMarkerPath: join(dir, 'stop-markers.txt'),
    eventsPath: join(dir, 'events.jsonl'),
    transcriptPath: join(dir, 'transcript.log'),
  };
}

test('buildPtySessionArgs can request remote-control for orchestrator readiness', () => {
  const args = buildPtySessionArgs({ ...baseOptions(), remoteControl: true });

  assert.ok(args.includes('--remote-control'));
  assert.equal(args.filter((arg) => arg === '--remote-control').length, 1);
  assert.deepEqual(args.slice(0, 8), [
    '--dangerously-skip-permissions',
    '--model',
    'opus',
    '--mcp-config',
    '.mcp.json',
    '--strict-mcp-config',
    '--remote-control',
    '--dangerously-load-development-channels',
  ]);
});

test('buildPtySessionArgs leaves remote-control off by default', () => {
  const args = buildPtySessionArgs(baseOptions());

  assert.equal(args.includes('--remote-control'), false);
});

test('buildPtySessionArgs preserves runtime relocation overrides', () => {
  const opts = baseOptions();
  const promptDir = join(opts.workspaceDir, '.project-companion');
  mkdirSync(promptDir, { recursive: true });
  const promptPath = join(promptDir, 'orchestrator.md');
  writeFileSync(promptPath, '# prompt\n');

  const args = buildPtySessionArgs({
    ...opts,
    model: 'sonnet',
    mcpConfigPath: join(opts.workspaceDir, 'session', 'mcp.json'),
    settingsPath: join(opts.workspaceDir, 'session', '.claude', 'settings.json'),
    settingSources: '',
    pluginDirs: [join(opts.workspaceDir, 'session', 'claude-plugin')],
    agentName: 'pc-runtime:orchestrator',
    appendSystemPromptPath: promptPath,
    claudeSessionId: 'session-uuid',
    resume: true,
    remoteControl: true,
  });

  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--settings'));
  assert.ok(args.includes('--plugin-dir'));
  assert.ok(args.includes('--agent'));
  assert.ok(args.includes('--append-system-prompt-file'));
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), [
    '--resume',
    'session-uuid',
  ]);
  assert.ok(args.includes('--dangerously-load-development-channels'));
});

test('buildPtySessionArgs can disable dev channels and mint a session id', () => {
  const args = buildPtySessionArgs({
    ...baseOptions(),
    claudeSessionId: 'fresh-session',
    resume: false,
    loadDevChannels: false,
  });

  assert.deepEqual(
    args.slice(args.indexOf('--session-id'), args.indexOf('--session-id') + 2),
    ['--session-id', 'fresh-session'],
  );
  assert.equal(args.includes('--dangerously-load-development-channels'), false);
  assert.equal(args.includes('--remote-control'), false);
});
