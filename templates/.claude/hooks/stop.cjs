// Stop hook — appends a turn-end marker. PC_SESSION_ID env var routes the
// marker to the per-session dir; falls back to project-wide if unset.

const { appendFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const PROJECT_DATA_DIR = '{{PROJECT_DATA_DIR}}';
const SESSION_ID = process.env.PC_SESSION_ID || '';
const DATA_DIR = SESSION_ID ? PROJECT_DATA_DIR + '/sessions/' + SESSION_ID : PROJECT_DATA_DIR;
const MARKER = DATA_DIR + '/stop-markers.txt';

try {
  mkdirSync(dirname(MARKER), { recursive: true });
  appendFileSync(MARKER, new Date().toISOString() + '\n');
} catch {
  // hook must not block turn end
}

process.exit(0);
