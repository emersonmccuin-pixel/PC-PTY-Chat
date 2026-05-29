import type { FolderProbe } from '../files/types';
import type { CreateProjectMode } from './types';

type CreateProjectProbe = Pick<
  FolderProbe,
  'exists' | 'isDirectory' | 'hasFiles' | 'isGitRepo' | 'hasPcScaffold'
>;

export function createProjectModeFromProbe(probe: CreateProjectProbe): CreateProjectMode | null {
  if (!probe.exists || !probe.isDirectory) return null;
  if (probe.isGitRepo) {
    if (probe.hasPcScaffold) return null;
    return 'attach-to-git';
  }
  return probe.hasFiles ? 'init-in-place' : 'init-empty';
}
