/**
 * The link between an opaque `DbClient` and the query clients behind it. Lint stops
 * anything outside `src/db/` importing this file, so code elsewhere can hold a client
 * and pass it to the functions here, but cannot build a query with it.
 */

import type { PostgrestClient } from "@supabase/postgrest-js";
import { sql as fragment, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { failure, failureFromError, type DbResult } from "./errors.ts";
import { functionValue } from "./result.ts";
import type { Database } from "./types.ts";

declare const dbClientBrand: unique symbol;

/** A database connection that only the functions in `src/db/` can use. */
export interface DbClient {
  readonly [dbClientBrand]: true;
}

export type RestClient = PostgrestClient<Database>;

/** A Drizzle database on any driver: node-postgres in production, PGlite in tests. */
export type SqlDatabase = PgDatabase<PgQueryResultHKT>;

interface Registered {
  readonly client: RestClient;
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

export function rest(db: DbClient): RestClient {
  return registered(db).client;
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
 * Runs one query and turns its outcome into a result. A query still running at the
 * client's deadline is abandoned and fails as `unavailable`: the caller gets its answer
 * in time, though the database may still finish the statement. The role's own
 * statement_timeout bounds that.
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
  const outcome = Promise.resolve()
    .then(() => query(sql))
    .then(
      (value): DbResult<T> => ({ ok: true, value }),
      (error: unknown) => failureFromError(error),
    );
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
