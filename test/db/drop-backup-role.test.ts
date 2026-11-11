/**
 * 20261113000020_drop_backup_role_access.sql takes away the old backup role's access and
 * drops it, or keeps it with no access when it cannot be dropped.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBootstrappedDb,
  migrationFiles,
  migrationScripts,
} from "./harness.ts";

const ROLE = "backup_ro";
const DROP_MIGRATION = "20261113000020_drop_backup_role_access.sql";

describe("dropping the backup role", () => {
  let db: PGlite;
  let dropScript: string;

  /** Every migration before the one under test, as the platform's owner. */
  async function migrateUpToDrop(): Promise<void> {
    const scripts = migrationScripts();
    const index = migrationFiles().indexOf(DROP_MIGRATION);
    expect(index, DROP_MIGRATION).toBeGreaterThan(0);
    dropScript = scripts[index] ?? "";
    for (const script of scripts.slice(0, index)) {
      await db.exec(script);
    }
  }

  async function role(): Promise<
    { rolcanlogin: boolean; rolbypassrls: boolean } | undefined
  > {
    const { rows } = await db.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = $1`, [
      ROLE,
    ]);
    return rows[0];
  }

  /** What the role can still reach in the app's schemas, by name. */
  async function access(): Promise<string[]> {
    const { rows } = await db.query<{ item: string }>(
      `SELECT 'table ' || c.relname AS item
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p', 'S')
         AND has_table_privilege($1, c.oid, 'SELECT')
       UNION ALL
       SELECT 'schema ' || nspname FROM pg_namespace
       WHERE nspname IN ('public', 'history') AND has_schema_privilege($1, oid, 'USAGE')
       UNION ALL
       SELECT 'policy ' || tablename FROM pg_policies WHERE $1 = ANY (roles)
       ORDER BY 1`,
      [ROLE],
    );
    return rows.map((row) => row.item);
  }

  beforeEach(async () => {
    db = await createBootstrappedDb();
    await migrateUpToDrop();
  });

  afterEach(async () => {
    await db.close();
  });

  it("starts from a role with read access and one policy per table", async () => {
    expect(await role()).toEqual({ rolcanlogin: false, rolbypassrls: false });
    const before = await access();
    expect(before).toContain("policy tasks");
    expect(before).toContain("table row_versions");
    expect(before).toContain("schema history");
  });

  it("drops the role and its policies", async () => {
    await db.exec(dropScript);

    expect(await role()).toBeUndefined();
    const { rows } = await db.query(`SELECT policyname FROM pg_policies`);
    expect(rows).toEqual([]);
  });

  it("drops a role that was given a login and BYPASSRLS by hand", async () => {
    await db.exec(`ALTER ROLE ${ROLE} LOGIN BYPASSRLS`);

    await db.exec(dropScript);

    expect(await role()).toBeUndefined();
  });

  it("runs again without error once the role is gone", async () => {
    await db.exec(dropScript);
    await db.exec(dropScript);

    expect(await role()).toBeUndefined();
  });

  it("keeps a role it cannot drop, with no login and no access", async () => {
    // A grant the migration's owner did not make, outside the app's schemas, stands in
    // for anything the role holds that this migration cannot take away.
    await db.exec(`
      CREATE SCHEMA elsewhere;
      CREATE TABLE elsewhere.kept (id int);
      GRANT USAGE ON SCHEMA elsewhere TO ${ROLE};
      GRANT SELECT ON elsewhere.kept TO ${ROLE};
      ALTER ROLE ${ROLE} LOGIN;
    `);

    await db.exec(dropScript);

    expect(await role()).toEqual({ rolcanlogin: false, rolbypassrls: false });
    expect(await access()).toEqual([]);
  });
});
