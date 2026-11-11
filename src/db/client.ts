/**
 * The server-side database client. It is built on first use, so importing this file
 * never reads a setting or opens a connection.
 */

import { getDatabaseUrl } from "../lib/env.ts";
import {
  rebuildWithDeadline,
  registerClient,
  sqlDatabase,
  type DbClient,
  type SqlDatabase,
} from "./internal.ts";
import { closePool, poolDatabase } from "./pool.ts";

export type { DbClient, SqlDatabase };

const DEFAULT_DEADLINE_MS = 8000;

/**
 * For a request Discord is waiting on. Discord allows 3 seconds for the first reply,
 * and this leaves time for a fixed reply if the read fails. An interaction handler
 * makes one such read and defers anything more.
 */
export const INTERACTION_DEADLINE_MS = 1500;

/**
 * A client on the given Drizzle database: a pooled connection in production, see
 * `poolDatabase`, or PGlite in tests. Each query is abandoned at the client's deadline.
 */
export function createDbClient(sql: SqlDatabase): DbClient {
  if ("window" in globalThis || "document" in globalThis) {
    throw new Error("The database client is server-side only");
  }
  const register = (deadlineMs: number): DbClient =>
    registerClient({ sql, deadlineMs, withDeadline: register });
  return register(DEFAULT_DEADLINE_MS);
}

/**
 * The same client with a shorter limit on each query. A query over the limit is
 * abandoned and fails as `unavailable`, though the database may still finish it, up to
 * the role's own statement_timeout.
 */
export function withDeadline(db: DbClient, deadlineMs: number): DbClient {
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > DEFAULT_DEADLINE_MS
  ) {
    throw new RangeError("Deadline out of range");
  }
  return rebuildWithDeadline(db, deadlineMs);
}

/** A new client from DATABASE_URL, with a pool shared with no other caller. */
export function createDbFromEnv(): DbClient {
  return createDbClient(poolDatabase(getDatabaseUrl()));
}

/** How long closing a client may take before its caller stops waiting. */
export const CLOSE_TIMEOUT_MS = 1000;

/**
 * Closes the connections of a client from `createDbFromEnv`, and of every client made
 * from it with `withDeadline`. For a caller done with the client, so a warm instance
 * keeps no connection between runs. Does nothing for any other client. Waits at most
 * `CLOSE_TIMEOUT_MS`: a pool whose connection hangs on the way out must not hold the
 * cron past its limit, and the server closes what is left.
 */
export async function closeDb(db: DbClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
  });
  try {
    await Promise.race([closePool(sqlDatabase(db)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let client: DbClient | undefined;

/** One client for the life of the function instance, for interaction handlers. */
export function getDb(): DbClient {
  client ??= createDbFromEnv();
  return client;
}

/** The client for a handler that has not deferred. See `INTERACTION_DEADLINE_MS`. */
export function getInteractionDb(): DbClient {
  return withDeadline(getDb(), INTERACTION_DEADLINE_MS);
}
