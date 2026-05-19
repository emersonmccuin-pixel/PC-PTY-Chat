// write-to-worktree step dispatcher (4a.5 / D19). Writes a single file inside
// the run's worktree. Path is resolved against `run.worktreePath` and rejected
// if it escapes the worktree root (containment check — analog to the path-
// guard hook but enforced directly here since the step bypasses CC's tool
// stack). Mode is `overwrite` (default) or `append`. No git side-effect — the
// workflow author chains a `bash` step with `git add && commit` when they
// want commit semantics.

import { mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { NodeOutput, WorkflowRun, WriteToWorktreeNode } from '@pc/domain';

import type { SubstituteTemplate } from './typed-substitution.ts';

export interface WriteToWorktreeStepResult {
  kind: 'sync';
  output: NodeOutput;
}

export interface WriteToWorktreeStepDeps {
  substituteTemplate: SubstituteTemplate;
}

export async function runWriteToWorktreeStep(
  node: WriteToWorktreeNode,
  run: WorkflowRun,
  deps: WriteToWorktreeStepDeps,
): Promise<WriteToWorktreeStepResult> {
  const completedAt = () => new Date().toISOString();
  const cfg = node['write-to-worktree'];

  if (!run.worktreePath) {
    return failedSync(
      `write-to-worktree requires the workflow to declare a worktree (worktree: auto); this run has no worktreePath`,
      completedAt(),
    );
  }

  const relPath = deps.substituteTemplate(cfg.path).trim();
  if (!relPath) {
    return failedSync(`path resolved to empty (raw: "${cfg.path}")`, completedAt());
  }
  if (isAbsolute(relPath)) {
    return failedSync(
      `path must be relative to the worktree (got absolute: "${relPath}")`,
      completedAt(),
    );
  }

  const worktreeRoot = resolve(run.worktreePath);
  const target = resolve(worktreeRoot, relPath);
  const rootWithSep = worktreeRoot.endsWith(sep) ? worktreeRoot : worktreeRoot + sep;
  if (target !== worktreeRoot && !target.startsWith(rootWithSep)) {
    return failedSync(
      `path escapes worktree root (resolved: "${target}", worktree: "${worktreeRoot}")`,
      completedAt(),
    );
  }

  // Refuse to overwrite a directory.
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      return failedSync(`refusing to write: "${target}" is a directory`, completedAt());
    }
  } catch {
    /* file doesn't exist — fine */
  }

  const content = deps.substituteTemplate(cfg.content);
  const mode = cfg.mode ?? 'overwrite';

  try {
    mkdirSync(dirname(target), { recursive: true });
    if (mode === 'append') {
      appendFileSync(target, content, 'utf-8');
    } else {
      writeFileSync(target, content, 'utf-8');
    }
  } catch (err) {
    return failedSync(`write failed: ${(err as Error).message}`, completedAt());
  }

  return {
    kind: 'sync',
    output: {
      status: 'complete',
      output: {
        path: relPath,
        absolutePath: target,
        bytes: Buffer.byteLength(content, 'utf-8'),
        mode,
      },
      completedAt: completedAt(),
    },
  };
}

function failedSync(error: string, completedAt: string): WriteToWorktreeStepResult {
  return {
    kind: 'sync',
    output: { status: 'failed', error, completedAt },
  };
}
