/** The production connection: Drizzle on node-postgres, through a small pool. */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { SqlDatabase } from "./internal.ts";

/**
 * Few connections, since each function instance serves one request at a time and the
 * pooler in front of the database shares its own. Idle ones close soon, so a frozen
 * instance holds little.
 */
const POOL = {
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
} as const;

/**
 * A Drizzle database on a small pg pool. Nothing connects until the first query. An
 * idle connection the server drops raises an error on the pool, and with no listener
 * that would end the process, so it is logged by type only: its message can name the
 * host or the role.
 */
export function poolDatabase(connectionString: string): SqlDatabase {
  const pool = new pg.Pool({ connectionString, ...POOL });
  pool.on("error", (error) => {
    console.error(`Database connection lost: ${error.name}`);
  });
  const database = drizzle({ client: pool });
  pools.set(database, pool);
  return database;
}

const pools = new WeakMap<SqlDatabase, pg.Pool>();

/** Ends the pool behind a database from `poolDatabase`. Does nothing for any other. */
export async function closePool(database: SqlDatabase): Promise<void> {
  await pools.get(database)?.end();
}
