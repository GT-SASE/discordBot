import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";
import { pgConnection, type Connection } from "../db/harness.ts";
import { urlForDatabase } from "./global-setup.ts";

/**
 * Races between two real connections, which PGlite cannot run because it has only one.
 * Each test has T1 hold a transaction open, proves through pg_blocking_pids that T2 is
 * waiting on T1, then lets T1 finish and checks what T2 got.
 */

const BLOCK_TIMEOUT_MS = 10_000;

export interface Outcome {
  rows?: Record<string, unknown>[];
  code?: string | undefined;
}

export type Statement = [sql: string, params: unknown[]];

export interface RaceDatabase {
  /** A connection outside the race, as the superuser, for setup and checks. */
  readonly observer: pg.Client;
  /** The observer, in the shape test/db/fixtures.ts takes. */
  readonly connection: Connection;
  readonly t1: pg.Client;
  readonly t2: pg.Client;
  /**
   * T1 runs its statement in an open transaction, T2 runs its statement and must block,
   * then T1 finishes. Returns what T2 got.
   */
  race(
    first: Statement,
    second: Statement,
    finish?: "COMMIT" | "ROLLBACK",
  ): Promise<Outcome>;
}

function settled(query: Promise<pg.QueryResult>): Promise<Outcome> {
  return query.then(
    (result) => ({ rows: result.rows as Record<string, unknown>[] }),
    (error: unknown) => ({ code: (error as { code?: string }).code }),
  );
}

async function pidOf(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = rows[0]?.pid;
  if (typeof pid !== "number") {
    throw new Error("pg_backend_pid returned no number");
  }
  return pid;
}

/**
 * Gives the calling file a database of its own, copied from the migrated template that
 * global-setup.ts made, and two fresh service_role connections for each test.
 */
export function raceDatabase(): RaceDatabase {
  const adminUrl = inject("concurrencyAdminUrl");
  const template = inject("concurrencyTemplate");
  const databaseName = `concurrency_${randomBytes(6).toString("hex")}`;
  const databaseUrl = urlForDatabase(adminUrl, databaseName);

  let observer: pg.Client | undefined;
  let t1: pg.Client | undefined;
  let t2: pg.Client | undefined;
  let t1Pid = 0;
  let t2Pid = 0;
  // Filled in as setup goes, so that a setup failure still cleans up what it made.
  const cleanups: (() => Promise<unknown>)[] = [];

  const ready = <T>(client: T | undefined): T => {
    if (client === undefined) {
      throw new Error("the race database is not set up");
    }
    return client;
  };

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    cleanups.unshift(() => cluster.end());
    await cluster.query(`CREATE DATABASE ${databaseName} TEMPLATE ${template}`);
    cleanups.unshift(() =>
      cluster.query(`DROP DATABASE IF EXISTS ${databaseName}`),
    );
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    observer = client;
    cleanups.unshift(() => client.end());
  });

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    t1 = new pg.Client({ connectionString: databaseUrl });
    t2 = new pg.Client({ connectionString: databaseUrl });
    await t1.connect();
    await t2.connect();
    await t1.query("SET ROLE service_role");
    await t2.query("SET ROLE service_role");
    // Read here, while both are idle. A query on a client that is already blocked would
    // queue behind the blocked statement and not return until the wait was over.
    t1Pid = await pidOf(t1);
    t2Pid = await pidOf(t2);
  });

  afterEach(async () => {
    await t1?.end();
    await t2?.end();
  });

  /** Waits until T2 is blocked by T1, and fails if that never happens. */
  async function waitUntilBlocked(): Promise<void> {
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { rows } = await ready(observer).query<{ blockers: number[] }>(
        "SELECT pg_blocking_pids($1) AS blockers",
        [t2Pid],
      );
      if (rows[0]?.blockers.includes(t1Pid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("T2 never blocked on T1");
  }

  return {
    get observer() {
      return ready(observer);
    },
    get connection() {
      return pgConnection(ready(observer));
    },
    get t1() {
      return ready(t1);
    },
    get t2() {
      return ready(t2);
    },
    async race(first, second, finish = "COMMIT") {
      const one = ready(t1);
      const two = ready(t2);
      await one.query("BEGIN");
      await one.query(first[0], first[1]);
      const outcome = settled(two.query(second[0], second[1]));
      try {
        await waitUntilBlocked();
      } finally {
        await one.query(finish);
      }
      return outcome;
    },
  };
}
