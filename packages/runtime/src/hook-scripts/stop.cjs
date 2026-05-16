const { appendFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const MARKER = 'E:/Projects/Caisson/data/stop-markers.txt';

try {
  mkdirSync(dirname(MARKER), { recursive: true });
  appendFileSync(MARKER, new Date().toISOString() + '\n');
} catch {
  // hook must not block turn end
}

process.exit(0);
