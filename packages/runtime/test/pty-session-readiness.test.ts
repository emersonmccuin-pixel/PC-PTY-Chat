import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalBufferLooksReady } from '../src/pty-session.ts';

test('detects legacy Claude welcome banners as ready', () => {
  assert.equal(terminalBufferLooksReady('Welcome back to Claude Code'), true);
  assert.equal(terminalBufferLooksReady('Tips for getting started'), true);
  assert.equal(terminalBufferLooksReady('Try "/help" for commands'), true);
});

test('detects remote-control prompt as ready', () => {
  assert.equal(
    terminalBufferLooksReady('/remote-control is active · Continue here...'),
    true,
  );
});

test('detects resume-mode cursor-forward rendering of remote-control prompt', () => {
  const resumePainting =
    '/remote-control\x1b[1Cis\x1b[1Cactive\x1b[1C·\x1b[1CContinue\x1b[1Chere';

  assert.equal(terminalBufferLooksReady(resumePainting), true);
});

test('does not mark unrelated output ready', () => {
  assert.equal(terminalBufferLooksReady('Loading development channels'), false);
});
