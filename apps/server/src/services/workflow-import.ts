// Section 19.13 — one-shot v2 YAML → DB workflow importer.
//
// Runs at project boot. Scans `<folder>/.project-companion/workflows/*.yaml`,
// parses each via the existing v2 parser, and inserts as `scope='project'`
// DB rows. Failed parses land as `status='invalid'` rows carrying the parse
// error string for the future History tab + retry path.
//
// Idempotent across boots (the 2-boot plan from workflow-page-rebuild.md):
//   1. YAML on disk + no DB row → parse + INSERT.
//   2. YAML on disk + healthy DB row (status='active', not soft-deleted) →
//      delete the YAML file (the DB row is canonical now).
//   3. YAML on disk + invalid/deleted DB row → leave the file alone (user can
//      edit the YAML in place + restart to re-import on a future pass).
//
// Concrete: Boot N runs (1); Boot N+1 runs (2) + (1) for any newly added
// YAMLs; from there on YAML files are gone and the importer is a no-op.
//
// All inserts thread an audit row with `actor='user'` + a fixed reason so
// they're greppable from the History tab.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { extname, basename, join } from 'node:path';

import type { ULID } from '@pc/domain';
import { parseWorkflowV2Text, isV2WorkflowText } from '@pc/workflows';
import { workflowsRepo } from '@pc/db';
import type { WorkflowAuditInput } from '@pc/db';

const IMPORT_AUDIT: WorkflowAuditInput = {
  actor: 'user',
  reason: 'imported from disk (19.13)',
};

export interface WorkflowImportResult {
  /** YAML files scanned in this project's workflows dir. */
  scanned: number;
  /** New DB rows inserted with status='active'. */
  imported: number;
  /** New DB rows inserted with status='invalid'. */
  importedInvalid: number;
  /** YAML files whose slug already has a healthy DB row — left alone or
   *  cleaned up depending on `cleanupHealthy`. */
  alreadyPresent: number;
  /** YAML files deleted because the DB row is canonical now (boot N+1
   *  behavior). Always 0 when `cleanupHealthy` is false. */
  yamlFilesDeleted: number;
  /** Files we skipped (non-yaml extensions, non-v2 marker — v1 leftovers). */
  skippedNonV2: number;
}

export interface ImportV2WorkflowsOptions {
  projectId: ULID;
  /** `<projectFolderPath>/.project-companion/workflows`. */
  workflowsDir: string;
  /** When true, delete YAML files whose slug already has a healthy DB row.
   *  Defaults to true — the 2-boot plan converges to "DB is canonical" without
   *  caller wiring. Tests can pass false to keep the fixture intact. */
  cleanupHealthy?: boolean;
}

/**
 * Scan the project's workflows dir + reconcile with the DB. See module header
 * for the 2-boot semantics. Returns a per-project summary suitable for the
 * boot log.
 *
 * Pure relative to `getDb()` + the fs — no project-runtime / channel-server
 * coupling. Safe to call from tests with a temp dir.
 */
export function importV2WorkflowsFromDisk(
  opts: ImportV2WorkflowsOptions,
): WorkflowImportResult {
  const result: WorkflowImportResult = {
    scanned: 0,
    imported: 0,
    importedInvalid: 0,
    alreadyPresent: 0,
    yamlFilesDeleted: 0,
    skippedNonV2: 0,
  };
  const cleanupHealthy = opts.cleanupHealthy !== false;

  if (!existsSync(opts.workflowsDir)) return result;

  const files = readdirSync(opts.workflowsDir).filter(
    (f) => extname(f) === '.yaml' || extname(f) === '.yml',
  );
  result.scanned = files.length;

  for (const fileName of files) {
    const filePath = join(opts.workflowsDir, fileName);
    const expectedId = basename(fileName, extname(fileName));

    let yamlText = '';
    try {
      yamlText = readFileSync(filePath, 'utf-8');
    } catch {
      // Unreadable — treat as non-v2 + skip. Pre-existing readdir already
      // confirmed the entry exists, so any failure here is exotic.
      result.skippedNonV2 += 1;
      continue;
    }

    if (!isV2WorkflowText(yamlText)) {
      // v1 leftover or unrelated YAML file. The 19.12 cull already removed v1
      // surfaces; any v1 yaml still sitting here is documentation at this
      // point. Leave it on disk untouched.
      result.skippedNonV2 += 1;
      continue;
    }

    // The slug is authoritative from the filename (matches the on-disk
    // registry's contract). parseWorkflowV2Text rewrites the body's id to
    // match expectedId.
    const slug = expectedId;
    const existing = workflowsRepo.getWorkflowBySlug({
      slug,
      scope: 'project',
      projectId: opts.projectId,
      includeDeleted: true,
    });
    if (existing) {
      result.alreadyPresent += 1;
      const isHealthy =
        existing.status === 'active' && existing.deletedAt === null;
      if (cleanupHealthy && isHealthy) {
        try {
          unlinkSync(filePath);
          result.yamlFilesDeleted += 1;
        } catch {
          // Swallow — re-trying next boot is fine.
        }
      }
      continue;
    }

    const yamlHash = sha256(yamlText);
    const parsed = parseWorkflowV2Text(yamlText, { expectedId });
    if (parsed.ok) {
      const name = parsed.workflow.name || slug;
      const description = parsed.workflow.description ?? null;
      workflowsRepo.createWorkflow(
        {
          slug,
          scope: 'project',
          projectId: opts.projectId,
          name,
          description,
          yaml: yamlText,
          yamlHash,
          parsedDefinition: parsed.workflow,
          status: 'active',
          disabled: parsed.workflow.disabled === true,
        },
        IMPORT_AUDIT,
      );
      result.imported += 1;
    } else {
      const errors = 'errors' in parsed ? parsed.errors : ['unknown parse error'];
      workflowsRepo.createWorkflow(
        {
          slug,
          scope: 'project',
          projectId: opts.projectId,
          name: slug,
          yaml: yamlText,
          yamlHash,
          parsedDefinition: null,
          status: 'invalid',
          parseError: errors.join('; '),
        },
        IMPORT_AUDIT,
      );
      result.importedInvalid += 1;
    }
  }

  return result;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
