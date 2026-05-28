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
