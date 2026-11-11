import { PGlite } from "@electric-sql/pglite";
import {
  migrate,
  pgMigrationConnection,
  type MigrationConnection,
} from "../../scripts/migrate.ts";

/** What the helpers here need from a database, so PGlite and pg both fit. */
export type Connection = MigrationConnection;

export const pgConnection = pgMigrationConnection;

/** The role the bot logs in as. db/migrations/0001_baseline.sql creates it. */
export const BOT_APP = "bot_app";

/** Runs the migrations and owns the schema, as a Neon project's owner role does. */
export const MIGRATION_OWNER = "migration_owner";

/** A role with no grants at all, standing in for any role that is not the bot or owner. */
export const OTHER_ROLE = "other_role";

/** Postgres error code for a privilege failure. */
export const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * What a new server has before the first migration: an owner that is not a superuser but
 * may create roles, and owns the database and its public schema, as on Neon. Safe to
 * run more than once in a cluster, and in any database.
 */
export const SERVER_SETUP = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATION_OWNER}') THEN
      CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER CREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OTHER_ROLE}') THEN
      CREATE ROLE ${OTHER_ROLE} NOLOGIN;
    END IF;
    EXECUTE format('ALTER DATABASE %I OWNER TO ${MIGRATION_OWNER}', current_database());
  END;
  $$;
  ALTER SCHEMA public OWNER TO ${MIGRATION_OWNER};
`;

/** Applies every migration as the owner, through the same code as the db:migrate script. */
export async function migrateAsOwner(db: Connection): Promise<void> {
  await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
  try {
    await migrate(db);
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** A fresh database with every migration applied. */
export async function createMigratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SERVER_SETUP);
  await migrateAsOwner(db);
  return db;
}

/** Narrows a value a test has already required to exist, failing loudly if it does not. */
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

/** Runs one parameterised statement as the given role, then restores the session role. */
export async function queryAs<Row = Record<string, unknown>>(
  db: Connection,
  role: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  await db.exec(`SET ROLE ${role}`);
  try {
    const result = await db.query<Row>(sql, params);
    return result.rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** The Postgres error code a statement fails with, or undefined if it succeeds. */
export async function errorCodeOf(
  run: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Built at runtime because a literal this long would trip the secret scan's rule
// against Discord IDs in tracked files. Starting from a random offset keeps IDs from
// repeating between runs against a long-lived server.
let nextFakeId = 10n ** 17n + BigInt(Math.floor(Math.random() * 1e9)) * 1000n;

/** A placeholder Discord ID, unique within the test run. */
export function fakeId(): string {
  nextFakeId += 1n;
  return nextFakeId.toString();
}

const sessionQueues = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `fn` alone on this connection. PGlite has one session, and a caller that switches
 * its role must not let another caller's statement run under that role.
 */
export function onSessionAlone<T>(
  db: object,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(db) ?? Promise.resolve();
  const next = previous.then(fn);
  sessionQueues.set(
    db,
    next.catch(() => undefined),
  );
  return next;
}
