/**
 * Applies the files in db/migrations that the database has not had yet, in order. Each
 * file runs in its own transaction, together with the row that records it in
 * public.schema_migrations, so a file is applied whole or not at all. Running this again
 * applies nothing new. Two runs at once take turns on an advisory lock. The ledger keeps
 * each file's sha256, and a run fails if an applied file has changed since: changes go
 * in new numbered files.
 *
 * Connect as the role that owns the schema, never as bot_app. Errors print only their
 * Postgres code and the file, since a message can quote the connection string or data.
 *
 * Usage: DATABASE_URL=<owner connection string> pnpm db:migrate
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "db",
  "migrations",
);

const FILE_NAME = /^([0-9]{4})_[a-z0-9_]+\.sql$/;
/** An arbitrary key, the same in every run, for pg_advisory_xact_lock. */
const LOCK_KEY = 4_812_301;

/** What applying needs from a connection, so pg and PGlite both fit. */
export interface MigrationConnection {
  // Callers name the row they expect, as they do with PGlite's own query.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
  /** Runs text that may hold several statements, with no parameters. */
  exec(sql: string): Promise<unknown>;
}

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
}

export class MigrationError extends Error {
  override name = "MigrationError";
}

/** Every migration file, in order. Refuses a badly named file or a repeated version. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = FILE_NAME.exec(name);
    const version = match?.[1];
    if (version === undefined) {
      throw new MigrationError(`${name} is not named NNNN_name.sql`);
    }
    if (migrations.some((migration) => migration.version === version)) {
      throw new MigrationError(`version ${version} is used twice`);
    }
    migrations.push({
      version,
      name,
      sql: readFileSync(join(dir, name), "utf8"),
    });
  }
  return migrations;
}

const CREATE_LEDGER = `
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
    name text NOT NULL,
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC;
`;

async function inTransaction<T>(
  connection: MigrationConnection,
  run: () => Promise<T>,
): Promise<T> {
  await connection.exec("BEGIN");
  try {
    await connection.query("SELECT pg_catalog.pg_advisory_xact_lock($1)", [
      LOCK_KEY,
    ]);
    const result = await run();
    await connection.exec("COMMIT");
    return result;
  } catch (error) {
    // A failed ROLLBACK, such as on a dropped connection, must not hide why the
    // transaction failed. Postgres ends the transaction when the session ends anyway.
    await connection.exec("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/** The hex sha256 of a migration's text, as the ledger records it. */
export function migrationHash(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Each applied version and the hash recorded for it. */
async function appliedVersions(
  connection: MigrationConnection,
): Promise<Map<string, string>> {
  const { rows } = await connection.query<{ version: string; sha256: string }>(
    "SELECT version, sha256 FROM public.schema_migrations",
  );
  return new Map(rows.map((row) => [row.version, row.sha256]));
}

/**
 * Settings a migration file cannot hold, because they name the database, whose name
 * differs per server and may not be built into a migration's SQL. Every role gets temp
 * tables through PUBLIC, which would let the bot store data outside its grants. The
 * owner keeps them. Safe to repeat.
 */
async function closeDatabase(connection: MigrationConnection): Promise<void> {
  const { rows } = await connection.query<{ name: string }>(
    "SELECT pg_catalog.current_database() AS name",
  );
  const name = rows[0]?.name ?? "";
  await connection.exec(
    `REVOKE TEMPORARY ON DATABASE "${name.replaceAll('"', '""')}" FROM PUBLIC`,
  );
  // The revoke cannot reach a grant made to bot_app itself, or one made by another
  // grantor, so check the result rather than trust it.
  const { rows: temp } = await connection.query<{ open: boolean }>(
    `SELECT CASE
       WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bot_app')
       THEN pg_catalog.has_database_privilege(
         'bot_app', pg_catalog.current_database(), 'TEMP'
       )
       ELSE false
     END AS open`,
  );
  if (temp[0]?.open !== false) {
    throw new MigrationError(
      "bot_app can still create temp tables in this database: revoke TEMPORARY from it and from every role it belongs to, then run this again",
    );
  }
}

/** Applies what is missing and returns the names of the files it applied. */
export async function migrate(
  connection: MigrationConnection,
  migrations: readonly Migration[] = readMigrations(),
): Promise<string[]> {
  const known = new Set(migrations.map((migration) => migration.version));
  await inTransaction(connection, async () => {
    await connection.exec(CREATE_LEDGER);
    const applied = await appliedVersions(connection);
    const unknown = [...applied.keys()].filter(
      (version) => !known.has(version),
    );
    if (unknown.length > 0) {
      throw new MigrationError(
        `the database has versions this checkout lacks: ${unknown.sort().join(", ")}`,
      );
    }
    const changed = migrations
      .filter((migration) => {
        const recorded = applied.get(migration.version);
        return (
          recorded !== undefined && recorded !== migrationHash(migration.sql)
        );
      })
      .map((migration) => migration.name);
    if (changed.length > 0) {
      throw new MigrationError(
        `applied files have changed since they ran: ${changed.join(", ")}. Put changes in a new numbered file`,
      );
    }
  });

  const applied: string[] = [];
  for (const migration of migrations) {
    const ran = await inTransaction(connection, async () => {
      // Checked again under the lock, in case another run got there first.
      if ((await appliedVersions(connection)).has(migration.version)) {
        return false;
      }
      try {
        await connection.exec(migration.sql);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        throw new MigrationError(
          `${migration.name} failed${typeof code === "string" ? ` with ${code}` : ""}`,
        );
      }
      await connection.query(
        "INSERT INTO public.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migrationHash(migration.sql)],
      );
      return true;
    });
    if (ran) {
      applied.push(migration.name);
    }
  }
  await inTransaction(connection, () => closeDatabase(connection));
  return applied;
}

/** A pg client in the shape `migrate` takes. */
export function pgMigrationConnection(client: pg.Client): MigrationConnection {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    query: async <Row>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as Row[] };
    },
    exec: (sql) => client.query(sql),
  };
}

export async function main(): Promise<number> {
  const url = process.env.DATABASE_URL?.trim();
  if (url === undefined || url === "") {
    console.error("DATABASE_URL must be set to the owner's connection string");
    return 1;
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const applied = await migrate(pgMigrationConnection(client));
    console.log(
      applied.length === 0
        ? "Nothing to apply."
        : `Applied ${applied.join(", ")}.`,
    );
    return 0;
  } catch (error) {
    console.error(
      error instanceof MigrationError
        ? error.message
        : `Migration failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
