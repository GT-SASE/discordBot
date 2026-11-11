/**
 * The link between an opaque `DbClient` and the Drizzle database behind it. Lint stops
 * anything outside `src/db/` importing this file, so code elsewhere can hold a client
 * and pass it to the functions here, but cannot build a query with it.
 */

import { is, sql as fragment, type SQL } from "drizzle-orm";
import {
  PgSelectBase,
  type PgDatabase,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import {
  failure,
  failureFromError,
  isDeadConnection,
  type DbResult,
} from "./errors.ts";
import { functionValue } from "./result.ts";

declare const dbClientBrand: unique symbol;

/** A database connection that only the functions in `src/db/` can use. */
export interface DbClient {
  readonly [dbClientBrand]: true;
}

/** A Drizzle database on any driver: node-postgres in production, PGlite in tests. */
export type SqlDatabase = PgDatabase<PgQueryResultHKT>;

interface Registered {
  readonly sql: SqlDatabase;
  readonly deadlineMs: number;
  readonly withDeadline: (deadlineMs: number) => DbClient;
}

const registry = new WeakMap<DbClient, Registered>();

export function registerClient(entry: Registered): DbClient {
  // Only ever a key in the registry, so it needs no properties of its own.
  const handle = Object.freeze({}) as unknown as DbClient;
  registry.set(handle, entry);
  return handle;
}

function registered(db: DbClient): Registered {
  const entry = registry.get(db);
  if (entry === undefined) {
    throw new TypeError("Not a database client");
  }
  return entry;
}

/** The Drizzle database behind a client, for closing it. Queries go through `run`. */
export function sqlDatabase(db: DbClient): SqlDatabase {
  return registered(db).sql;
}

export function rebuildWithDeadline(
  db: DbClient,
  deadlineMs: number,
): DbClient {
  return registered(db).withDeadline(deadlineMs);
}

/**
 * Sends the query, and sends it once more if it is a read that failed on a dead
 * connection. A read is told apart by the builder it returns, a select, so a write or a
 * function call, which may have run before its connection died, is never sent twice.
 */
async function attempt<T>(
  sql: SqlDatabase,
  query: (sql: SqlDatabase) => PromiseLike<T>,
): Promise<DbResult<T>> {
  let read = false;
  try {
    const pending = query(sql);
    read = is(pending, PgSelectBase);
    return { ok: true, value: await pending };
  } catch (error) {
    if (!read || !isDeadConnection(error)) {
      return failureFromError(error);
    }
  }
  try {
    return { ok: true, value: await query(sql) };
  } catch (error) {
    return failureFromError(error);
  }
}

/**
 * Runs one query and turns its outcome into a result. A query still running at the
 * client's deadline is abandoned and fails as `unavailable`: the caller gets its answer
 * in time, though the database may still finish the statement. The role's own
 * statement_timeout bounds that. A read that meets a dead connection is tried once more
 * within the same deadline.
 */
export async function run<T>(
  db: DbClient,
  query: (sql: SqlDatabase) => PromiseLike<T>,
): Promise<DbResult<T>> {
  const { sql, deadlineMs } = registered(db);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DbResult<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve(failure("unavailable"));
    }, deadlineMs);
  });
  const outcome = attempt(sql, query);
  try {
    return await Promise.race([outcome, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls one database function and returns what it returned. Pass the call as a sql
 * template, such as fragment`public.claim_interaction(${id})`, so every argument is a
 * parameter. Lint refuses anything else.
 */
export async function callFunction(
  db: DbClient,
  call: SQL,
): Promise<DbResult<unknown>> {
  return functionValue(
    await run(db, (sql) => sql.execute(fragment`select ${call} as value`)),
  );
}
