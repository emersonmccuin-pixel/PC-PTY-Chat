import { monotonicFactory } from 'ulid';
import type { ULID } from '@pc/domain';

/** Monotonic ULID factory: two calls within the same millisecond return
 *  strictly-increasing IDs so `ORDER BY id ASC` matches insertion order. */
const nextUlid = monotonicFactory();

export function newId(): ULID {
  return nextUlid() as ULID;
}
