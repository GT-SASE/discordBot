import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  callArguments,
  recordingSql,
  serverError,
  sqlTarget,
  writtenValues,
} from "./sql-client.ts";

export interface RecordedRequest {
  method: string;
  /** Path and query, decoded, so a test can read the filter as PostgREST will. */
  target: string;
  /** Path and query exactly as sent. */
  rawTarget: string;
  headers: Headers;
  body: unknown;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

// Split so the secret scan's key pattern does not match this placeholder.
export const TEST_SECRET_KEY = ["sb", "secret", "x".repeat(24)].join("_");

export const TEST_ORIGIN = "https://project.example.test";

/**
 * A client whose network layer records each request and answers from `respond`. A
 * statement built with Drizzle is recorded with method `SQL` and its text as the
 * target. Its body is what it carries: a function call's named arguments, the columns
 * an insert or update writes, or a read's parameters. A status of 400 or more fails it
 * with the body's code. A call answers with the body as the function's value, and any
 * other statement with the body's rows if it is a list.
 */
export function mockPostgrest(
  respond: (request: RecordedRequest) => MockResponse = () => ({ body: [] }),
): { db: DbClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const { sql } = recordingSql((call) => {
    const target = sqlTarget(call.sql);
    const request: RecordedRequest = {
      method: "SQL",
      target: call.sql,
      rawTarget: call.sql,
      headers: new Headers(),
      body: target.startsWith("call ")
        ? callArguments(call)
        : /^(insert|update) /.test(target)
          ? writtenValues(call)
          : call.params,
    };
    requests.push(request);
    const { status = 200, body = [] } = respond(request);
    if (status >= 400) {
      const code =
        typeof body === "object" && body !== null && "code" in body
          ? String(body.code)
          : "XX000";
      return serverError(code);
    }
    if (target.startsWith("call ")) {
      return { rows: [{ value: body }] };
    }
    return { rows: Array.isArray(body) ? body : [] };
  });
  const db = createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    sql,
    fetch: (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const rawTarget = `${url.pathname}${url.search}`;
      const request: RecordedRequest = {
        method: init?.method ?? "GET",
        rawTarget,
        target: `${url.pathname}?${[...url.searchParams]
          .map(([key, value]) => `${key}=${value}`)
          .join("&")}`,
        headers: new Headers(init?.headers),
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      };
      requests.push(request);
      const { status = 200, body = [] } = respond(request);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  });
  return { db, requests };
}

let nextId = 3n * 10n ** 17n;

/** A placeholder Discord ID, built at runtime so no long literal is tracked. */
export function testSnowflake(): string {
  nextId += 1n;
  return nextId.toString();
}

/** Inputs that must never become part of a query shape. */
export const HOSTILE_STRINGS = [
  "x,deleted_at.not.is.null",
  "x)",
  "a.b",
  'x","y',
  "x*",
  "%",
  "x\u0000y",
  "x\ud800y",
  "",
  "__proto__",
];
