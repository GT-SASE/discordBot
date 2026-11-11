import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  callArguments,
  recordingSql,
  serverError,
  sqlTarget,
  writtenValues,
} from "./sql-client.ts";

/** One statement the database layer sent. */
export interface RecordedRequest {
  /** The statement's text, with a `$n` for each value. */
  target: string;
  /** A call's named arguments, the columns a write sets, or a read's parameters. */
  values: unknown;
}

/**
 * How a mocked statement answers: with the rows it returns, with the value a function
 * call returns, or by failing with a Postgres error code.
 */
export type MockResponse =
  | { readonly rows: readonly unknown[] }
  | { readonly value: unknown }
  | { readonly error: string };

/**
 * A client that runs nothing: it records each statement and answers from `respond`. A
 * statement is recorded with its text as the target and the values it carries: a
 * function call's named arguments, the columns an insert or update writes, or a read's
 * parameters. An answer with `rows` returns those rows as the driver would, `value`
 * returns one row holding a function call's value, and `error` fails with that code.
 */
export function mockDb(
  respond: (request: RecordedRequest) => MockResponse = () => ({ rows: [] }),
): { db: DbClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const { sql } = recordingSql((call) => {
    const target = sqlTarget(call.sql);
    const request: RecordedRequest = {
      target: call.sql,
      values: target.startsWith("call ")
        ? callArguments(call)
        : /^(insert|update) /.test(target)
          ? writtenValues(call)
          : call.params,
    };
    requests.push(request);
    const response = respond(request);
    if ("error" in response) {
      return serverError(response.error);
    }
    if ("value" in response) {
      if (!target.startsWith("call ")) {
        throw new TypeError(
          `only a function call returns a value: ${call.sql}`,
        );
      }
      return { rows: [{ value: response.value }] };
    }
    return { rows: [...response.rows] };
  });
  const db = createDbClient(sql);
  return { db, requests };
}

let nextId = 3n * 10n ** 17n;

/** A placeholder Discord ID, built at runtime so no long literal is tracked. */
export function testSnowflake(): string {
  nextId += 1n;
  return nextId.toString();
}

/** Inputs that must never become part of a query's text. */
export const HOSTILE_STRINGS = [
  "x' OR '1'='1",
  "x'); DROP TABLE public.tasks; --",
  '"; SELECT 1; --',
  "$1",
  "x\\",
  "%",
  "_",
  "x\u0000y",
  "x\ud800y",
  "",
  "__proto__",
];
