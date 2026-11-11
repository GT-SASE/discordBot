import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MigrationError,
  migrate,
  migrationHash,
  readMigrations,
  type Migration,
  type MigrationConnection,
} from "./migrate.ts";

function migration(version: string, sql: string): Migration {
  return { version, name: `${version}_test.sql`, sql };
}

describe("migrate", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
  });

  afterEach(async () => {
    await db.close();
  });

  async function versions(): Promise<string[]> {
    const { rows } = await db.query<{ version: string }>(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    return rows.map((row) => row.version);
  }

  it("applies each file once, in order, and records it", async () => {
    const files = [
      migration("0001", "CREATE TABLE public.a (id int);"),
      migration("0002", "INSERT INTO public.a VALUES (1);"),
    ];

    expect(await migrate(db, files)).toEqual([
      "0001_test.sql",
      "0002_test.sql",
    ]);
    expect(await migrate(db, files)).toEqual([]);

    expect(await versions()).toEqual(["0001", "0002"]);
    const { rows } = await db.query("SELECT id FROM public.a");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("applies only what is new", async () => {
    await migrate(db, [migration("0001", "CREATE TABLE public.a (id int);")]);
    const applied = await migrate(db, [
      migration("0001", "CREATE TABLE public.a (id int);"),
      migration("0002", "CREATE TABLE public.b (id int);"),
    ]);
    expect(applied).toEqual(["0002_test.sql"]);
  });

  it("rolls a failing file back whole, records nothing for it, and names only the file and code", async () => {
    const files = [
      migration("0001", "CREATE TABLE public.a (id int);"),
      migration(
        "0002",
        "CREATE TABLE public.b (id int); SELECT 'secret-value'::int;",
      ),
    ];

    const failure = await migrate(db, files).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as Error).message).toBe(
      "0002_test.sql failed with 22P02 at position 40, line 1, in the statement starting: SELECT 'secret-value'::int;",
    );
    // The server's message, which can quote row data, is never passed on.
    expect((failure as Error).message).not.toContain("invalid input");
    expect(await versions()).toEqual(["0001"]);
    const { rows } = await db.query(
      "SELECT to_regclass('public.b') IS NULL AS absent",
    );
    expect(rows).toEqual([{ absent: true }]);
  });

  it("names the line and statement of a failure inside a longer file", async () => {
    const sql = [
      "-- Two tables; the second is wrong.",
      "CREATE TABLE public.a (id int);",
      "",
      "/* a comment; with a semicolon */",
      "CREATE TABLE public.b (",
      "  note text DEFAULT 'a;b',",
      "  id nosuchtype",
      ");",
    ].join("\r\n");

    const failure = await migrate(db, [migration("0001", sql)]).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toMatch(
      /^0001_test\.sql failed with 42704 at position \d+, line 7, in the statement starting: CREATE TABLE public\.b \($/,
    );
  });

  it("gives only the code when Postgres gives no position", async () => {
    const failure = await migrate(db, [
      migration(
        "0001",
        "DO $$ BEGIN RAISE EXCEPTION 'row text' USING ERRCODE = 'P0001'; END $$;",
      ),
    ]).catch((error: unknown) => error);

    expect((failure as Error).message).toBe("0001_test.sql failed with P0001");
  });

  it("refuses a database that has versions the checkout lacks", async () => {
    await migrate(db, [
      migration("0001", "SELECT 1;"),
      migration("0002", "SELECT 1;"),
    ]);
    await expect(migrate(db, [migration("0001", "SELECT 1;")])).rejects.toThrow(
      "the database has versions this checkout lacks: 0002",
    );
  });

  it("records each file's sha256", async () => {
    const sql = "CREATE TABLE public.a (id int);";
    await migrate(db, [migration("0001", sql)]);
    const { rows } = await db.query<{ sha256: string }>(
      "SELECT sha256 FROM public.schema_migrations",
    );
    expect(rows).toEqual([{ sha256: migrationHash(sql) }]);
    expect(migrationHash(sql)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a file with CRLF line endings as it does the same file with LF", async () => {
    const lf =
      "CREATE TABLE public.a (id int);\nCREATE TABLE public.b (id int);\n";
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(migrationHash(crlf)).toBe(migrationHash(lf));
    expect(migrationHash(lf)).not.toBe(migrationHash(lf.replace("b", "c")));

    await migrate(db, [migration("0001", crlf)]);
    expect(await migrate(db, [migration("0001", lf)])).toEqual([]);
  });

  it("refuses an applied file whose contents have changed, and applies nothing", async () => {
    await migrate(db, [migration("0001", "CREATE TABLE public.a (id int);")]);
    const failure = await migrate(db, [
      migration("0001", "CREATE TABLE public.a (id bigint);"),
      migration("0002", "CREATE TABLE public.b (id int);"),
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as Error).message).toContain(
      "applied files have changed since they ran: 0001_test.sql",
    );
    expect(await versions()).toEqual(["0001"]);
  });

  it("keeps the original error when the rollback fails too", async () => {
    const failing: MigrationConnection = {
      query: (sql, params) => db.query(sql, params),
      exec: async (sql) => {
        if (sql === "ROLLBACK") {
          await db.exec("ROLLBACK");
          throw new Error("connection lost");
        }
        return db.exec(sql);
      },
    };

    const failure = await migrate(failing, [
      migration("0001", "SELECT 'x'::int;"),
    ]).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationError);
    expect((failure as Error).message).toMatch(
      /^0001_test\.sql failed with 22P02 at position/,
    );
  });

  it("refuses to finish while bot_app can still create temp tables", async () => {
    const files = [
      migration(
        "0001",
        `CREATE ROLE bot_app;
         DO $$ BEGIN
           EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO bot_app', current_database());
         END $$;`,
      ),
    ];
    await expect(migrate(db, files)).rejects.toThrow(
      "bot_app can still create temp tables in this database",
    );

    await db.exec("REVOKE TEMPORARY ON DATABASE postgres FROM bot_app");
    expect(await migrate(db, files)).toEqual([]);
  });

  it("passes the temp check once PUBLIC loses temp tables", async () => {
    await migrate(db, [migration("0001", "CREATE ROLE bot_app;")]);
    const { rows } = await db.query(
      "SELECT has_database_privilege('bot_app', current_database(), 'TEMP') AS temp",
    );
    expect(rows).toEqual([{ temp: false }]);
  });

  it("keeps the ledger closed to every role but its owner", async () => {
    await migrate(db, []);
    const { rows } = await db.query(
      `SELECT c.relrowsecurity,
              ARRAY(SELECT a.grantee FROM aclexplode(c.relacl) AS a
                    WHERE a.grantee <> c.relowner) AS others
       FROM pg_class c WHERE c.oid = 'public.schema_migrations'::regclass`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, others: [] }]);
  });
});

describe("readMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("reads files in version order", () => {
    writeFileSync(join(dir, "0002_b.sql"), "SELECT 2;");
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    expect(readMigrations(dir).map((file) => file.version)).toEqual([
      "0001",
      "0002",
    ]);
  });

  it.each(["1_a.sql", "0001-a.sql", "0001_a.txt", "0001_A.sql"])(
    "refuses a file named %s",
    (name) => {
      writeFileSync(join(dir, name), "SELECT 1;");
      expect(() => readMigrations(dir)).toThrow(MigrationError);
    },
  );

  it("refuses a repeated version", () => {
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0001_b.sql"), "SELECT 1;");
    expect(() => readMigrations(dir)).toThrow("version 0001 is used twice");
  });

  it("reads this repo's migrations", () => {
    expect(readMigrations().length).toBeGreaterThan(0);
  });
});
