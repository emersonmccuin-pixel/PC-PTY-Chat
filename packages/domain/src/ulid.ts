/**
 * Opaque ULID identifier. Construct via `id as ULID` at trust boundaries
 * (DB row hydration, validated request payloads, fresh-id generation).
 * Generation lives in `@pc/db` (`newId()`).
 */
export type ULID = string & { readonly _brand: 'ULID' };
