/**
 * Applies the files in db/migrations that the database has not had yet, in order. Each
 * file runs in its own transaction, together with the row that records it in
 * public.schema_migrations, so a file is applied whole or not at all. Running this again
 * applies nothing new. Two runs at once take turns on an advisory lock. The ledger keeps
 * each file's sha256, and a run fails if an applied file has changed since: changes go
 * in new numbered files.
 *
 * Connect as the role that owns the schema, never as bot_app. Errors print only the
 * file, the Postgres code and, when Postgres gives a position, where in the file it
 * failed, since a message can quote the connection string or data.
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

/**
 * The hex sha256 of a migration's text, as the ledger records it. Line endings are
 * made LF first, so a checkout with CRLF endings, as Git gives on Windows by default,
 * hashes the same as any other.
 */
export function migrationHash(sql: string): string {
  return createHash("sha256")
    .update(sql.replaceAll("\r\n", "\n"), "utf8")
    .digest("hex");
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

/** The index just past the comment, quoted text or dollar-quoted body at `index`. */
function skipQuoted(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const end = sql.indexOf("\n", index);
    return end === -1 ? sql.length : end;
  }
  if (sql.startsWith("/*", index)) {
    let depth = 0;
    let at = index;
    while (at < sql.length) {
      if (sql.startsWith("/*", at)) {
        depth += 1;
        at += 2;
      } else if (sql.startsWith("*/", at)) {
        depth -= 1;
        at += 2;
        if (depth === 0) {
          return at;
        }
      } else {
        at += 1;
      }
    }
    return sql.length;
  }
  const char = sql.charAt(index);
  if (char === "'" || char === '"') {
    let at = index + 1;
    while (at < sql.length) {
      if (sql.charAt(at) !== char) {
        at += 1;
      } else if (sql.charAt(at + 1) === char) {
        at += 2;
      } else {
        return at + 1;
      }
    }
    return sql.length;
  }
  const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
    sql.slice(index, index + 64),
  );
  if (char === "$" && tag !== null) {
    const close = sql.indexOf(tag[0], index + tag[0].length);
    return close === -1 ? sql.length : close + tag[0].length;
  }
  return index + 1;
}

/**
 * Where a 1-based character position in a file falls: its line, and the first line of
 * the statement holding it, past any comments. Statements end at a semicolon outside
 * comments, quotes and function bodies.
 */
export function locateInMigration(
  sql: string,
  position: number,
): { line: number; statement: string } {
  // Postgres counts characters, and a string index counts UTF-16 units.
  const offset = Array.from(sql)
    .slice(0, Math.max(position - 1, 0))
    .join("").length;
  let start = 0;
  let index = 0;
  while (index < offset) {
    if (sql.charAt(index) === ";") {
      start = index + 1;
      index += 1;
    } else {
      index = skipQuoted(sql, index);
    }
  }
  let first = start;
  for (;;) {
    while (/\s/.test(sql.charAt(first))) {
      first += 1;
    }
    if (!sql.startsWith("--", first) && !sql.startsWith("/*", first)) {
      break;
    }
    first = skipQuoted(sql, first);
  }
  const lineEnd = sql.slice(first).search(/\r?\n/);
  const statement = sql
    .slice(first, lineEnd === -1 ? sql.length : first + lineEnd)
    .trim();
  return {
    line: sql.slice(0, offset).split("\n").length,
    statement:
      statement.length > 120 ? `${statement.slice(0, 117)}...` : statement,
  };
}

/**
 * What a failed file reports: its SQLSTATE and, when Postgres gives one, the position
 * of the error, its line, and the first line of the statement there, all from the file
 * itself. The server's message and detail are left out, since they can quote row data,
 * and the connection string never reaches this.
 */
function failureMessage(migration: Migration, error: unknown): string {
  const { code, position } = error as { code?: unknown; position?: unknown };
  let message = `${migration.name} failed`;
  if (typeof code === "string") {
    message += ` with ${code}`;
  }
  const at = typeof position === "string" ? Number(position) : Number.NaN;
  if (Number.isInteger(at) && at > 0) {
    const { line, statement } = locateInMigration(migration.sql, at);
    message += ` at position ${String(at)}, line ${String(line)}, in the statement starting: ${statement}`;
  }
  return message;
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
        throw new MigrationError(failureMessage(migration, error));
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
