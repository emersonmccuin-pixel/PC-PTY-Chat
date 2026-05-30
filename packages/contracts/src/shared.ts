export type ULID = string;

export type ApiErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: ApiErrorCode; details?: unknown };

export type ApiOk<T extends object = {}> = { ok: true } & T;

export interface ApiErr<TDetails = unknown> {
  ok: false;
  error: string;
  code?: ApiErrorCode;
  details?: TDetails;
}

export type ApiResult<TOk extends object, TDetails = unknown> =
  | ApiOk<TOk>
  | ApiErr<TDetails>;

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseErr(
  error: string,
  code: ApiErrorCode = 'VALIDATION',
  details?: unknown,
): ParseResult<never> {
  return details === undefined
    ? { ok: false, error, code }
    : { ok: false, error, code, details };
}
