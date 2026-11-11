/** The production connection: Drizzle on node-postgres, through a pool. */

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { SqlDatabase } from "./internal.ts";

/**
 * How a pool is used, which sets how long it waits to open a connection and whether it
 * keeps the function instance alive while connections sit idle.
 */
export interface PoolUse {
  readonly connectionTimeoutMillis: number;
  readonly attachToInstance: boolean;
}

/**
 * Under Fluid compute one instance serves several requests at once, so a pool must hold
 * enough connections for them: a request that finds all of them busy waits, and counts
 * that wait against its deadline. An interaction makes one short read before replying,
 * so 10 covers a burst of 10 commands or clicks landing on one instance at the same
 * moment, more than a club server sends, and the 11th waits only for the next free
 * connection. Neon's pooler accepts up to 10,000 client connections, so 10 per instance
 * across many instances stays far under it. Idle connections close after 10 seconds,
 * so a quiet instance holds none for long. TCP keepalive finds a connection that died
 * while the instance was suspended, and `query_timeout`, just over the role's 10 second
 * statement_timeout, gives up on a socket that went silent, so a query cannot hold its
 * connection forever after the caller's own deadline has passed.
 */
const POOL = {
  max: 10,
  idleTimeoutMillis: 10_000,
  query_timeout: 11_000,
  keepAlive: true,
  allowExitOnIdle: true,
} as const;

/**
 * A Drizzle database on a pg pool. Nothing connects until the first query. An idle
 * connection the server drops raises an error on the pool, and with no listener that
 * would end the process, so it is logged by type only: its message can name the host or
 * the role.
 */
export function poolDatabase(
  connectionString: string,
  use: PoolUse,
): SqlDatabase {
  const pool = new pg.Pool({
    connectionString,
    ...POOL,
    connectionTimeoutMillis: use.connectionTimeoutMillis,
  });
  pool.on("error", (error) => {
    console.error(`Database connection lost: ${error.name}`);
  });
  if (use.attachToInstance) {
    attachDatabasePool(pool);
  }
  const database = drizzle({ client: pool });
  pools.set(database, pool);
  return database;
}

const pools = new WeakMap<SqlDatabase, pg.Pool>();

/** Ends the pool behind a database from `poolDatabase`. Does nothing for any other. */
export async function closePool(database: SqlDatabase): Promise<void> {
  await pools.get(database)?.end();
}
