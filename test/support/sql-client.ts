/**
 * Drizzle databases for tests, on the driver the tests use instead of node-postgres.
 * The queries are the ones src/db builds for production: only where they run differs.
 */

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { SqlDatabase } from "../../src/db/client.ts";
import { BOT_APP, onSessionAlone } from "../db/harness.ts";

/** One statement as Drizzle sends it. */
export interface SqlCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * What a test answers a statement with instead of running it: rows to return, or an
 * error to throw. Undefined lets the statement run.
 */
export type SqlAnswer = { readonly rows: unknown[] } | Error | undefined;

export type Intercept = (call: SqlCall) => SqlAnswer | Promise<SqlAnswer>;

/** A failure as the server would raise it, with a SQLSTATE and a message to never show. */
export function serverError(code: string, message = "canary row text"): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}

type QueryArgs = Parameters<PGlite["query"]>;

/**
 * Runs every statement on the migrated database as bot_app, the role the bot logs in as,
 * so the grants, policies, triggers and functions all apply. `intercept` sees each one
 * first, and may answer it instead. Pass a function for a database made later, such as
 * in a `beforeAll`.
 */
export function pgliteSql(
  source: PGlite | (() => PGlite),
  intercept?: Intercept,
): SqlDatabase {
  const client = {
    // The intercept runs first and outside the session lock, so it may itself use the
    // database, as a test staging a race does.
    query: async (...[text, params = [], options]: QueryArgs) => {
      const answer = await intercept?.({ sql: text, params });
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer !== undefined) {
        return { rows: answer.rows, fields: [], affectedRows: 0 };
      }
      const database = typeof source === "function" ? source() : source;
      return onSessionAlone(database, async () => {
        await database.exec(`SET ROLE ${BOT_APP}`);
        try {
          return await database.query(text, params, options);
        } finally {
          await database.exec("RESET ROLE");
        }
      });
    },
  };
  return drizzle({ client: client as unknown as PGlite });
}

/**
 * A database that runs nothing. It records each statement and answers with `respond`,
 * or with no rows. A read built with Drizzle's query builder takes each row as an array
 * of values in the order selected; a function call takes objects.
 */
export function recordingSql(respond: Intercept = () => ({ rows: [] })): {
  sql: SqlDatabase;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const client = {
    query: async (...[text, params = []]: QueryArgs) => {
      const call = { sql: text, params };
      calls.push(call);
      const answer = (await respond(call)) ?? { rows: [] };
      if (answer instanceof Error) {
        throw answer;
      }
      return { rows: answer.rows, fields: [], affectedRows: 0 };
    },
  };
  return { sql: drizzle({ client: client as unknown as PGlite }), calls };
}

/** The table named by the first `from` outside any parentheses, or undefined. */
function topLevelFrom(text: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && text.startsWith(' from "', index)) {
      return /^ from "([a-z_]+)"/.exec(text.slice(index))?.[1];
    }
  }
  return undefined;
}

/** A read of this table, as the main table of a select and not in a subquery. */
export function readsFrom(call: SqlCall, table: string): boolean {
  return call.sql.startsWith("select ") && topLevelFrom(call.sql) === table;
}

/**
 * A well-formed DATABASE_URL for settings checks. Nothing listens there. The user and
 * password are set on a parsed URL, so no credential-shaped text is tracked.
 */
export function testDatabaseUrl(): string {
  const url = new URL("postgresql://db.example.test/bot?sslmode=verify-full");
  url.username = "bot_app";
  url.password = ["not", "a", "password"].join("-");
  return url.toString();
}

/**
 * A short name for what a statement does, for tests to match on: `select <table>`,
 * `insert <table>`, `update <table>` or `call <function>`.
 */
export function sqlTarget(text: string): string {
  const call = /^select public\.([a-z_]+)\(/.exec(text);
  if (call !== null) {
    return `call ${String(call[1])}`;
  }
  const write = /^(insert into|update) "([a-z_]+)"/.exec(text);
  if (write !== null) {
    return `${write[1] === "update" ? "update" : "insert"} ${String(write[2])}`;
  }
  return `select ${topLevelFrom(text) ?? "?"}`;
}

/** The columns a simple select names, in order, by their own names. */
export function selectedColumns(text: string): string[] {
  const end = text.indexOf(` from "${topLevelFrom(text) ?? ""}"`);
  return [
    ...text
      .slice("select ".length, end)
      .matchAll(/(?:"[a-z_]+"\.)?"([a-z_]+)"(?:,|$)/g),
  ].map((match) => String(match[1]));
}

/** Rows as a query built with Drizzle's builder takes them: the selected values in order. */
export function asSelected(
  text: string,
  rows: readonly Record<string, unknown>[],
): unknown[][] {
  const columns = selectedColumns(text);
  return rows.map((row) => columns.map((column) => row[column]));
}

/** Each `"column" <op> $n` in a statement, as column and operator to value. */
export function comparisons(call: SqlCall): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const match of call.sql.matchAll(
    /(?:"[a-z_]+"\.)?"([a-z_]+)" (=|>|<|>=|<=) \$([0-9]+)/g,
  )) {
    const [, column = "", operator = "", index = "0"] = match;
    found.set(`${column} ${operator}`, call.params[Number(index) - 1]);
  }
  return found;
}

/** The value bound to `limit $n`, if the statement has one. */
export function limitOf(call: SqlCall): number | undefined {
  const index = / limit \$([0-9]+)$/.exec(call.sql)?.[1];
  return index === undefined
    ? undefined
    : Number(call.params[Number(index) - 1]);
}
