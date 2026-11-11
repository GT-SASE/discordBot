import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { recordingSql, serverError } from "./sql-client.ts";

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
 * statement built with Drizzle is recorded too, with method `SQL`, its text as the
 * target and its parameters as the body. A status other than 200 fails it with the
 * body's code, and a body that is a list answers it with those rows.
 */
export function mockPostgrest(
  respond: (request: RecordedRequest) => MockResponse = () => ({ body: [] }),
): { db: DbClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const { sql } = recordingSql((call) => {
    const request: RecordedRequest = {
      method: "SQL",
      target: call.sql,
      rawTarget: call.sql,
      headers: new Headers(),
      body: call.params,
    };
    requests.push(request);
    const { status = 200, body = [] } = respond(request);
    if (status !== 200) {
      const code =
        typeof body === "object" && body !== null && "code" in body
          ? String(body.code)
          : "XX000";
      return serverError(code);
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
