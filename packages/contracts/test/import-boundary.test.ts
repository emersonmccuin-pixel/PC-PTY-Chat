import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const bannedImportPatterns = [
  /from\s+['"]node:/,
  /from\s+['"]hono['"]/,
  /from\s+['"]react['"]/,
  /from\s+['"]@pc\/(?:db|domain|runtime|mcp|workflows|utils)['"]/,
  /from\s+['"](?:\.\.\/)*apps\//,
];

test('@pc/contracts source stays browser-safe and adapter-free', () => {
  assert.equal(existsSync(srcDir), true);
  const violations: string[] = [];
  for (const file of listTsFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of bannedImportPatterns) {
      if (pattern.test(source)) violations.push(`${file}: ${pattern}`);
    }
  }
  assert.deepEqual(violations, []);
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
