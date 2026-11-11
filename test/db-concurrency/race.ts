import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, inject } from "vitest";
import { closeDb, createDbClient, type DbClient } from "../../src/db/client.ts";
import { poolDatabase } from "../../src/db/pool.ts";
import { pgConnection, type Connection } from "../db/harness.ts";
import { botUrlForDatabase, urlForDatabase } from "./global-setup.ts";

/**
 * Races between two real connections, which PGlite cannot run because it has only one.
 * Each test has T1, a connection logged in as bot_app, hold a transaction open. The
 * second side is the bot itself: a function from src/db on a client built the way
 * production builds it, through a pg pool logged in as bot_app. The race proves through
 * pg_blocking_pids that the bot's query waits on T1, then lets T1 finish and returns
 * what the bot got.
 */

const BLOCK_TIMEOUT_MS = 10_000;

export type Statement = [sql: string, params: unknown[]];

export interface RaceDatabase {
  /** A connection outside the race, as the superuser, for setup and checks. */
  readonly observer: pg.Client;
  /** The observer, in the shape test/db/fixtures.ts takes. */
  readonly connection: Connection;
  /** The bot's own client, logged in as bot_app, as production builds it. */
  readonly db: DbClient;
  /** A connection logged in as bot_app, for statements the bot never sends. */
  readonly t1: pg.Client;
  /**
   * T1 runs its statement in an open transaction, the bot's call runs and must block,
   * then T1 finishes. Returns what the bot's call returned.
   */
  race<T>(
    first: Statement,
    second: (db: DbClient) => Promise<T>,
    finish?: "COMMIT" | "ROLLBACK",
  ): Promise<T>;
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
 * global-setup.ts made, the bot's client on it, and a fresh bot_app connection for T1
 * in each test.
 */
export function raceDatabase(): RaceDatabase {
  const adminUrl = inject("concurrencyAdminUrl");
  const template = inject("concurrencyTemplate");
  const botPassword = inject("concurrencyBotPassword");
  const databaseName = `concurrency_${randomBytes(6).toString("hex")}`;
  const databaseUrl = urlForDatabase(adminUrl, databaseName);
  const botUrl = botUrlForDatabase(adminUrl, databaseName, botPassword);

  let observer: pg.Client | undefined;
  let bot: DbClient | undefined;
  let t1: pg.Client | undefined;
  let t1Pid = 0;
  // Filled in as setup goes, so that a setup failure still cleans up what it made.
  const cleanups: (() => Promise<unknown>)[] = [];

  const ready = <T>(value: T | undefined): T => {
    if (value === undefined) {
      throw new Error("the race database is not set up");
    }
    return value;
  };

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    cleanups.unshift(() => cluster.end());
    await cluster.query(`CREATE DATABASE ${databaseName} TEMPLATE ${template}`);
    // A copy does not keep the template's own grants, so close temp tables again, as
    // scripts/migrate.ts does on a real database.
    await cluster.query(
      `REVOKE TEMPORARY ON DATABASE ${databaseName} FROM PUBLIC`,
    );
    cleanups.unshift(() =>
      cluster.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    );
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    observer = client;
    cleanups.unshift(() => client.end());
    const db = createDbClient(poolDatabase(botUrl));
    bot = db;
    cleanups.unshift(() => closeDb(db));
  });

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    t1 = new pg.Client({ connectionString: botUrl });
    await t1.connect();
    t1Pid = await pidOf(t1);
  });

  afterEach(async () => {
    await t1?.end();
  });

  /** Waits until another bot_app backend is blocked by T1, and fails if none ever is. */
  async function waitUntilBlocked(): Promise<void> {
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { rows } = await ready(observer).query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
         WHERE usename = 'bot_app' AND $1 = ANY (pg_blocking_pids(pid))`,
        [t1Pid],
      );
      if ((rows[0]?.blocked ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the bot's query never blocked on T1");
  }

  return {
    get observer() {
      return ready(observer);
    },
    get connection() {
      return pgConnection(ready(observer));
    },
    get db() {
      return ready(bot);
    },
    get t1() {
      return ready(t1);
    },
    async race(first, second, finish = "COMMIT") {
      const one = ready(t1);
      await one.query("BEGIN");
      await one.query(first[0], first[1]);
      const outcome = second(ready(bot));
      try {
        await waitUntilBlocked();
      } finally {
        await one.query(finish);
      }
      return outcome;
    },
  };
}
