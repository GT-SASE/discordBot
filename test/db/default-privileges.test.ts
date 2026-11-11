import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  OTHER_ROLE,
  createMigratedDb,
  errorCodeOf,
  present,
  queryAs,
} from "./harness.ts";

interface Access {
  table: boolean;
  sequence: boolean;
  fn: boolean;
  type: boolean;
}

/** Creates objects the way a later migration would and reports what a role can do with them. */
async function accessToNewObjects(
  db: PGlite,
  role: string,
  suffix: string,
): Promise<Access> {
  await queryAs(
    db,
    MIGRATION_OWNER,
    `CREATE TABLE public.probe_${suffix} (id int)`,
  );
  await queryAs(
    db,
    MIGRATION_OWNER,
    `CREATE SEQUENCE public.probe_${suffix}_seq`,
  );
  await queryAs(
    db,
    MIGRATION_OWNER,
    `CREATE FUNCTION public.probe_${suffix}_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  );
  await queryAs(
    db,
    MIGRATION_OWNER,
    `CREATE TYPE public.probe_${suffix}_type AS ENUM ('a')`,
  );
  const result = await db.query<Access>(
    `SELECT
       has_table_privilege($1, 'public.probe_${suffix}', 'SELECT') AS table,
       has_sequence_privilege($1, 'public.probe_${suffix}_seq', 'USAGE') AS sequence,
       has_function_privilege($1, 'public.probe_${suffix}_fn()', 'EXECUTE') AS fn,
       has_type_privilege($1, 'public.probe_${suffix}_type', 'USAGE') AS type`,
    [role],
  );
  return present(result.rows[0]);
}

/** The bot's role, and a role with nothing, standing in for any other. */
const ROLES = [BOT_APP, OTHER_ROLE] as const;

describe("default privileges", () => {
  let migrated: PGlite;

  beforeAll(async () => {
    migrated = await createMigratedDb();
  });

  afterAll(async () => {
    await migrated.close();
  });

  it.each(ROLES)(
    "objects a later migration creates are closed to %s",
    async (role) => {
      const access = await accessToNewObjects(migrated, role, `closed_${role}`);
      expect(access).toEqual({
        table: false,
        sequence: false,
        fn: false,
        type: false,
      });
    },
  );

  it("new functions in any schema are not executable by PUBLIC", async () => {
    await queryAs(
      migrated,
      MIGRATION_OWNER,
      `CREATE FUNCTION public.probe_public_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
    );
    const { rows } = await migrated.query<{ proacl: string[] }>(
      `SELECT proacl::text[] AS proacl FROM pg_proc WHERE proname = 'probe_public_fn'`,
    );
    // An ACL entry starting with "=" is a grant to PUBLIC.
    expect(rows[0]?.proacl.filter((entry) => entry.startsWith("="))).toEqual(
      [],
    );
  });

  it("only bot_app can use the public schema", async () => {
    const { rows } = await migrated.query<{ rolname: string }>(
      `SELECT rolname FROM unnest($1::text[]) AS rolname WHERE has_schema_privilege(rolname, 'public', 'USAGE')`,
      [ROLES],
    );
    expect(rows).toEqual([{ rolname: BOT_APP }]);
  });

  it.each(ROLES)(
    "%s cannot create objects in the public schema",
    async (role) => {
      const code = await errorCodeOf(
        queryAs(migrated, role, `CREATE TABLE public.intruder (id int)`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    },
  );
});
