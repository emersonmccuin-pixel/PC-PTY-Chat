import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const webSrc = path.join(repoRoot, 'apps/web/src');

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(fullPath);
      return [fullPath];
    }),
  );
  return files.flat();
}

function repoRelative(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

test('web chat surface lives behind the chat feature boundary', async () => {
  const files = await listFiles(webSrc);
  const relativeFiles = new Set(files.map(repoRelative));

  assert.ok(
    relativeFiles.has('apps/web/src/features/chat/ChatSurface.tsx'),
    'ChatSurface should live in features/chat',
  );
  assert.ok(
    !relativeFiles.has('apps/web/src/components/ChatSurface.tsx'),
    'components/ChatSurface.tsx should not be reintroduced',
  );

  const offenders: string[] = [];
  for (const file of files.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const source = await readFile(file, 'utf8');
    if (source.includes('@/components/ChatSurface')) {
      offenders.push(repoRelative(file));
    }
  }

  assert.deepEqual(offenders, [], 'ChatSurface imports must use @/features/chat/ChatSurface');
});

test('web feature clients stay as HTTP method modules with colocated contracts', async () => {
  const files = await listFiles(webSrc);
  const clientFiles = files.filter((file) => /\/features\/[^/]+\/client\.ts$/.test(repoRelative(file)));

  const contractExportPattern =
    /^\s*export\s+(?:interface|type|class|enum|function|const\s+[A-Z0-9_]+)/m;
  const offenders: string[] = [];

  for (const file of clientFiles) {
    const source = await readFile(file, 'utf8');
    if (contractExportPattern.test(source)) offenders.push(repoRelative(file));
  }

  assert.deepEqual(
    offenders,
    [],
    'feature client.ts files should only expose API objects plus compatibility re-exports',
  );
});

test('web source imports feature clients directly instead of the legacy API barrel', async () => {
  const files = await listFiles(webSrc);
  const offenders: string[] = [];

  for (const file of files.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const source = await readFile(file, 'utf8');
    if (source.includes('@/api/client')) offenders.push(repoRelative(file));
  }

  assert.deepEqual(offenders, [], 'web source should not import @/api/client directly');
});

test('web websocket protocol types live outside the project ws hook', async () => {
  const files = await listFiles(webSrc);
  const relativeFiles = new Set(files.map(repoRelative));

  assert.ok(
    relativeFiles.has('apps/web/src/features/runtime/ws-types.ts'),
    'ws-types contract module should live under features/runtime',
  );

  const hookImportPattern =
    /from\s+['"](?:@\/hooks\/use-project-ws|\.{1,2}\/[^'"]*use-project-ws)['"]/;
  const allowedHookImporters = new Set(['apps/web/src/App.tsx']);
  const offenders: string[] = [];

  for (const file of files.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const rel = repoRelative(file);
    if (rel === 'apps/web/src/hooks/use-project-ws.ts') continue;
    if (allowedHookImporters.has(rel)) continue;

    const source = await readFile(file, 'utf8');
    if (hookImportPattern.test(source)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    'web code should import WS protocol types from @/features/runtime/ws-types instead of the hook',
  );
});

test('agent run websocket envelope contracts live outside transcript components', async () => {
  const files = await listFiles(webSrc);
  const relativeFiles = new Set(files.map(repoRelative));
  const contractFile = 'apps/web/src/features/agent-runs/transcript.ts';

  assert.ok(
    relativeFiles.has(contractFile),
    'agent run transcript contract module should live under features/agent-runs',
  );

  const offenders: string[] = [];
  const contractPattern =
    /\b(?:interface|type)\s+AgentJsonlEnvelope\b|\bfunction\s+isAgentJsonlEnvelope\b/;

  for (const file of files.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const rel = repoRelative(file);
    if (rel === contractFile) continue;

    const source = await readFile(file, 'utf8');
    if (contractPattern.test(source)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    'agent-jsonl-event contracts should stay in @/features/agent-runs/transcript',
  );
});

test('terminal transcript helpers live outside the xterm component', async () => {
  const files = await listFiles(webSrc);
  const relativeFiles = new Set(files.map(repoRelative));
  const contractFile = 'apps/web/src/features/chat/terminalTranscript.ts';

  assert.ok(
    relativeFiles.has(contractFile),
    'terminal transcript helpers should live under features/chat',
  );

  const helperPattern =
    /\bfunction\s+(?:terminalRawFromEnvelope|maxTerminalSeq|removeOverlappingPrefix)\b|\bconst\s+OVERLAP_SCAN_BYTES\b/;
  const offenders: string[] = [];

  for (const file of files.filter((candidate) => /\.(ts|tsx)$/.test(candidate))) {
    const rel = repoRelative(file);
    if (rel === contractFile) continue;

    const source = await readFile(file, 'utf8');
    if (helperPattern.test(source)) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    'terminal transcript parsing and overlap helpers should stay in @/features/chat/terminalTranscript',
  );
});
