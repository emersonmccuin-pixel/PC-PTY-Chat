// Stop hook — appends a turn-end marker.
//
// Identity guard: bail out unless PC_SESSION_ID is set. Outer Claude Code
// dev sessions running in this repo would otherwise drop stop markers into
// PC's project data dir. Same identity-bleed class as Section 15's JSONL fix.

if (!process.env.PC_SESSION_ID) process.exit(0);

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
