import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

test('dev supervisor builds sibling API and agent-host child specs', async () => {
  const mod = await import(
    new URL('../scripts/dev-supervisor-processes.mjs', import.meta.url).href
  );
  const serverDir = resolve('E:/repo/apps/server');
  const env = {
    PC_DATA_DIR: resolve('E:/pc-data'),
    PATH: 'test-path',
  };
  const tsxCli = resolve('E:/repo/node_modules/tsx/dist/cli.mjs');
  const execPath = resolve('E:/node/node.exe');

  const api = mod.buildApiChildSpec({ serverDir, tsxCli, execPath, env });
  assert.equal(api.name, 'api');
  assert.equal(api.command, execPath);
  assert.deepEqual(api.args, ['--report-on-fatalerror', tsxCli, 'src/index.ts']);
  assert.equal(api.cwd, serverDir);
  assert.equal(api.env, env);

  const host = mod.buildAgentHostChildSpec({ serverDir, tsxCli, execPath, env });
  const lockFile = resolve(env.PC_DATA_DIR, 'agent-host', 'host.lock.json');
  assert.equal(host.name, 'agent-host');
  assert.equal(host.command, execPath);
  assert.deepEqual(host.args, [
    '--report-on-fatalerror',
    tsxCli,
    resolve('E:/repo/packages/agent-host/src/cli.ts'),
    '--http-lock-file',
    lockFile,
  ]);
  assert.equal(host.cwd, resolve('E:/repo/packages/agent-host'));
  assert.equal(host.env.PC_AGENT_HOST_LOCK_FILE, lockFile);
  assert.equal(host.env.PATH, env.PATH);
});

test('dev supervisor sentinel restart decision applies only to the API child', async () => {
  const mod = await import(
    new URL('../scripts/dev-supervisor-processes.mjs', import.meta.url).href
  );

  assert.equal(
    mod.shouldRespawnApiChild({ code: 75, signalled: false }),
    true,
  );
  assert.equal(
    mod.shouldRespawnApiChild({ code: 75, signalled: true }),
    false,
  );
  assert.equal(
    mod.shouldRespawnApiChild({ code: 1, signalled: false }),
    false,
  );
});
