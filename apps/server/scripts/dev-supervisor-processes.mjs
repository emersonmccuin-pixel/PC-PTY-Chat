import { resolve } from 'node:path';

export const API_CHILD_NAME = 'api';
export const AGENT_HOST_CHILD_NAME = 'agent-host';

export function resolveRepoRoot(serverDir) {
  return resolve(serverDir, '..', '..');
}

export function resolveDevDataDir(serverDir, env = process.env) {
  return env.PC_DATA_DIR && env.PC_DATA_DIR !== 'undefined'
    ? env.PC_DATA_DIR
    : resolve(resolveRepoRoot(serverDir), 'data');
}

export function resolveAgentHostLockPath(serverDir, env = process.env) {
  return resolve(resolveDevDataDir(serverDir, env), 'agent-host', 'host.lock.json');
}

export function buildApiChildSpec({ serverDir, tsxCli, execPath = process.execPath, env = process.env }) {
  return {
    name: API_CHILD_NAME,
    command: execPath,
    args: ['--report-on-fatalerror', tsxCli, 'src/index.ts'],
    cwd: serverDir,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: false,
  };
}

export function buildAgentHostChildSpec({
  serverDir,
  tsxCli,
  execPath = process.execPath,
  env = process.env,
}) {
  const repoRoot = resolveRepoRoot(serverDir);
  const lockFile = resolveAgentHostLockPath(serverDir, env);
  return {
    name: AGENT_HOST_CHILD_NAME,
    command: execPath,
    args: [
      '--report-on-fatalerror',
      tsxCli,
      resolve(repoRoot, 'packages', 'agent-host', 'src', 'cli.ts'),
      '--http-lock-file',
      lockFile,
    ],
    cwd: resolve(repoRoot, 'packages', 'agent-host'),
    env: {
      ...env,
      PC_AGENT_HOST_LOCK_FILE: lockFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  };
}

export function shouldRespawnApiChild({ code, signalled }) {
  return !signalled && code === 75;
}
