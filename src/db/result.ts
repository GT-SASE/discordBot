/** Turns query outcomes into results, with the row counts each caller expects. */

import { failure, type DbResult } from "./errors.ts";
import type { ExcludedRow, RowParser } from "./types.ts";
import { isUuid } from "./validate.ts";

/** The rows a query returned, or why it failed. */
export type Rows = DbResult<readonly unknown[]>;

export interface RowList<T> {
  readonly rows: T[];
  /** Rows that failed their checks. Callers should log these: they hold no row text. */
  readonly excluded: ExcludedRow[];
}

export interface CappedList<T> extends RowList<T> {
  /** True if the database held more rows than the cap, so this list is not all of them. */
  readonly truncated: boolean;
}

function parseAll<T>(raw: readonly unknown[], parse: RowParser<T>): RowList<T> {
  const rows: T[] = [];
  const excluded: ExcludedRow[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed.ok) {
      rows.push(parsed.row);
    } else {
      excluded.push(parsed.excluded);
    }
  }
  return { rows, excluded };
}

export function rowList<T>(
  raw: Rows,
  parse: RowParser<T>,
): DbResult<RowList<T>> {
  return raw.ok ? { ok: true, value: parseAll(raw.value, parse) } : raw;
}

/** For a query that asked for `cap + 1` rows. The extra row only shows there are more. */
export function cappedList<T>(
  raw: Rows,
  parse: RowParser<T>,
  cap: number,
): DbResult<CappedList<T>> {
  if (!raw.ok) {
    return raw;
  }
  return {
    ok: true,
    value: {
      ...parseAll(raw.value.slice(0, cap), parse),
      truncated: raw.value.length > cap,
    },
  };
}

/** A read by key: at most one row. A row that fails its checks is a `bad_row` failure. */
export function oneOrNone<T>(
  raw: Rows,
  parse: RowParser<T>,
): DbResult<T | null> {
  const list = rowList(raw, parse);
  if (!list.ok) {
    return list;
  }
  const { rows, excluded } = list.value;
  if (excluded.length > 0 || rows.length > 1) {
    return failure("bad_row");
  }
  return { ok: true, value: rows[0] ?? null };
}

/**
 * A write that must change exactly one row. No match is `not_found`, covering a row
 * that is absent, in another guild, or no longer meets the write's conditions.
 */
export function exactlyOne<T>(raw: Rows, parse: RowParser<T>): DbResult<T> {
  if (!raw.ok) {
    return raw;
  }
  const [first, ...others] = raw.value;
  if (first === undefined) {
    return failure("not_found");
  }
  if (others.length > 0) {
    return failure("unexpected");
  }
  const parsed = parse(first);
  return parsed.ok ? { ok: true, value: parsed.row } : failure("bad_row");
}

export function booleanValue(result: DbResult<unknown>): DbResult<boolean> {
  if (!result.ok) {
    return result;
  }
  return typeof result.value === "boolean"
    ? { ok: true, value: result.value }
    : failure("bad_row");
}

export function integerValue(result: DbResult<unknown>): DbResult<number> {
  if (!result.ok) {
    return result;
  }
  return typeof result.value === "number" && Number.isSafeInteger(result.value)
    ? { ok: true, value: result.value }
    : failure("bad_row");
}

export function nullableUuidValue(
  result: DbResult<unknown>,
): DbResult<string | null> {
  if (!result.ok) {
    return result;
  }
  return result.value === null || isUuid(result.value)
    ? { ok: true, value: result.value }
    : failure("bad_row");
}

/**
 * The value a call to one database function returned: the one column of the one row
 * that `select public.f(...) AS value` gives. Anything else is a `bad_row`.
 */
export function functionValue(result: DbResult<unknown>): DbResult<unknown> {
  if (!result.ok) {
    return result;
  }
  const rows: unknown =
    typeof result.value === "object" && result.value !== null
      ? (result.value as { rows?: unknown }).rows
      : undefined;
  if (!Array.isArray(rows) || rows.length !== 1) {
    return failure("bad_row");
  }
  const [row] = rows as unknown[];
  return typeof row === "object" && row !== null && Object.hasOwn(row, "value")
    ? { ok: true, value: (row as { value: unknown }).value }
    : failure("bad_row");
}

/** A function's answer that is a JSON array of rows, as rows to check one by one. */
export function jsonRows(result: DbResult<unknown>): Rows {
  if (!result.ok) {
    return result;
  }
  return Array.isArray(result.value)
    ? { ok: true, value: result.value as readonly unknown[] }
    : failure("bad_row");
}
