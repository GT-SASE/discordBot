/**
 * src/db/schema.ts mirrors db/migrations by hand. These compare it with the database the
 * migrations build, so a column added, dropped, retyped or made nullable on either side
 * fails here.
 */

import type { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENUMS,
  INSERT_TABLES,
  TABLES,
  isoTimestamp,
} from "../../src/db/schema.ts";
import { createMigratedDb } from "./harness.ts";

/** Tables the schema leaves out on purpose. See the note at the top of schema.ts. */
const NOT_MIRRORED = ["schema_migrations"];

interface ColumnShape {
  column: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
}

function drizzleColumns(table: (typeof TABLES)[number]): ColumnShape[] {
  return getTableConfig(table)
    .columns.map((column) => ({
      column: column.name,
      type: column.getSQLType(),
      notNull: column.notNull,
      hasDefault: column.hasDefault || column.generatedIdentity !== undefined,
    }))
    .sort((a, b) => a.column.localeCompare(b.column));
}

function drizzlePrimaryKey(table: (typeof TABLES)[number]): string[] {
  const config = getTableConfig(table);
  const composite = config.primaryKeys.flatMap((key) =>
    key.columns.map((column) => column.name),
  );
  const single = config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  return [...composite, ...single].sort();
}

describe("the drizzle schema", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it("names every table in the public schema", async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect(
      rows
        .map((row) => row.name)
        .filter((name) => !NOT_MIRRORED.includes(name)),
    ).toEqual(TABLES.map((table) => getTableConfig(table).name).sort());
  });

  it.each(TABLES.map((table) => [getTableConfig(table).name, table] as const))(
    "matches the columns of %s",
    async (name, table) => {
      const { rows } = await db.query<ColumnShape>(
        `SELECT column_name AS column,
                CASE
                  WHEN domain_name IS NOT NULL THEN domain_name
                  WHEN data_type = 'USER-DEFINED' THEN udt_name
                  WHEN data_type = 'time without time zone' THEN 'time'
                  ELSE data_type
                END AS type,
                is_nullable = 'NO' AS "notNull",
                column_default IS NOT NULL OR is_identity = 'YES' AS "hasDefault"
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY column_name`,
        [name],
      );
      expect(drizzleColumns(table)).toEqual(
        [...rows].sort((a, b) => a.column.localeCompare(b.column)),
      );
    },
  );

  it.each(TABLES.map((table) => [getTableConfig(table).name, table] as const))(
    "matches the primary key of %s",
    async (name, table) => {
      const { rows } = await db.query<{ column: string }>(
        `SELECT a.attname AS column
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary
         ORDER BY 1`,
        [name],
      );
      expect(drizzlePrimaryKey(table)).toEqual(rows.map((row) => row.column));
    },
  );

  it.each(
    INSERT_TABLES.map((table) => [getTableConfig(table).name, table] as const),
  )(
    "inserts into %s only the columns bot_app may insert, with their types",
    async (name, table) => {
      const { rows } = await db.query<{ column: string }>(
        `SELECT column_name AS column FROM information_schema.column_privileges
         WHERE grantee = 'bot_app' AND privilege_type = 'INSERT'
           AND table_schema = 'public' AND table_name = $1
         ORDER BY 1`,
        [name],
      );
      const insertable = getTableConfig(table).columns;
      expect(insertable.map((column) => column.name).sort()).toEqual(
        rows.map((row) => row.column),
      );
      const full = TABLES.find((each) => getTableConfig(each).name === name);
      const types = new Map(
        (full === undefined ? [] : drizzleColumns(full)).map((column) => [
          column.column,
          column.type,
        ]),
      );
      for (const column of insertable) {
        expect(column.getSQLType()).toBe(types.get(column.name));
      }
    },
  );

  it("names every enum, with the same values in the same order", async () => {
    const { rows } = await db.query<{ name: string; values: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public'
       GROUP BY t.typname
       ORDER BY t.typname`,
    );
    expect(
      ENUMS.map((enumType) => ({
        name: enumType.enumName,
        values: [...enumType.enumValues],
      })),
    ).toEqual(rows);
  });
});

describe("isoTimestamp", () => {
  it.each([
    ["2030-01-10 12:00:00.123456+00", "2030-01-10T12:00:00.123456+00:00"],
    ["2030-01-10 12:00:00+00", "2030-01-10T12:00:00+00:00"],
    ["2030-01-10 07:00:00.5-05", "2030-01-10T07:00:00.5-05:00"],
    ["2030-01-10 12:00:00+05:30", "2030-01-10T12:00:00+05:30"],
  ])("turns %s into %s", (text, iso) => {
    expect(isoTimestamp(text)).toBe(iso);
  });

  it("keeps the exact instant, microseconds included", async () => {
    const db = await createMigratedDb();
    try {
      const { rows } = await db.query<{ same: boolean }>(
        `SELECT $1::timestamptz = '2030-01-10 12:00:00.123456+00'::timestamptz AS same`,
        [isoTimestamp("2030-01-10 12:00:00.123456+00")],
      );
      expect(rows).toEqual([{ same: true }]);
    } finally {
      await db.close();
    }
  });

  it("passes on anything else unchanged, for the row checks to refuse", () => {
    expect(isoTimestamp("infinity")).toBe("infinity");
  });
});
