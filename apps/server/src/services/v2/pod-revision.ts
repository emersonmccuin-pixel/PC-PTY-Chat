// Section 25 Session 8 — convenience re-export of the pod-revision helper.
// The implementation lives in @pc/db (drizzle-only dep). This file exists
// for ergonomic imports inside the apps/server/v2 surface.

export {
  computePodRevision,
  podRevisionsDiffer,
} from '@pc/db';
export type { ComputePodRevisionInput } from '@pc/db';
