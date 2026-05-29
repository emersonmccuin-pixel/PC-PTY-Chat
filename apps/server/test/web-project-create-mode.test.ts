import assert from 'node:assert/strict';
import { test } from 'node:test';

type CreateProjectModeModule = {
  createProjectModeFromProbe: (probe: {
    exists: boolean;
    isDirectory: boolean;
    hasFiles: boolean;
    isGitRepo: boolean;
    hasPcScaffold: boolean;
  }) => 'init-empty' | 'init-in-place' | 'attach-to-git' | null;
};

async function loadCreateModeModule(): Promise<CreateProjectModeModule> {
  const moduleUrl = new URL('../../web/src/features/projects/createMode.ts', import.meta.url).href;
  return (await import(moduleUrl)) as CreateProjectModeModule;
}

function probe(
  patch: Partial<Parameters<CreateProjectModeModule['createProjectModeFromProbe']>[0]>,
): Parameters<CreateProjectModeModule['createProjectModeFromProbe']>[0] {
  return {
    exists: true,
    isDirectory: true,
    hasFiles: false,
    isGitRepo: false,
    hasPcScaffold: false,
    ...patch,
  };
}

test('create project mode derivation rejects unavailable or unsafe folders', async () => {
  const { createProjectModeFromProbe } = await loadCreateModeModule();

  assert.equal(createProjectModeFromProbe(probe({ exists: false })), null);
  assert.equal(createProjectModeFromProbe(probe({ isDirectory: false })), null);
  assert.equal(
    createProjectModeFromProbe(probe({ isGitRepo: true, hasPcScaffold: true })),
    null,
  );
});

test('create project mode derivation maps valid folder probes to server modes', async () => {
  const { createProjectModeFromProbe } = await loadCreateModeModule();

  assert.equal(createProjectModeFromProbe(probe({ hasFiles: false })), 'init-empty');
  assert.equal(createProjectModeFromProbe(probe({ hasFiles: true })), 'init-in-place');
  assert.equal(createProjectModeFromProbe(probe({ isGitRepo: true })), 'attach-to-git');
});
