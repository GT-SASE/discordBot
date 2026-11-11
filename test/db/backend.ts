/**
 * Where the access layer tests run. With POSTGREST_URL set they go through a real
 * PostgREST server, which is what CI does, and otherwise through the local stand-in
 * on PGlite. The client under test is the same in both: only `fetch` differs.
 */

import { createHmac } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  createDbClient,
  type DbClient,
  type SqlDatabase,
} from "../../src/db/client.ts";
import { TEST_ORIGIN, TEST_SECRET_KEY } from "../support/mock-postgrest.ts";
import { pgliteSql } from "../support/sql-client.ts";
import {
  BOT_APP,
  createMigratedDb,
  pgConnection,
  type Connection,
} from "./harness.ts";
import { postgrestShim } from "./postgrest-shim.ts";

export interface Backend {
  /** A superuser connection, for setting up rows the bot's role cannot write. */
  connection: Connection;
  db: DbClient;
  /**
   * A client that runs `before` ahead of each request, to stage a race at that point.
   * A statement built with Drizzle comes as method `SQL` and its text.
   */
  dbWith: (before: (method: string, path: string) => Promise<void>) => DbClient;
  close: () => Promise<unknown>;
}

type SqlFor = (
  before?: (method: string, path: string) => Promise<void>,
) => SqlDatabase;

function clientFor(send: typeof fetch, sql: SqlDatabase): DbClient {
  return createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    fetch: send,
    sql,
  });
}

function withBackend(
  send: typeof fetch,
  sqlFor: SqlFor,
  connection: Connection,
  close: () => Promise<unknown>,
): Backend {
  return {
    connection,
    db: clientFor(send, sqlFor()),
    dbWith: (before) =>
      clientFor(async (input, init) => {
        const url =
          typeof input === "string" || input instanceof URL ? input : input.url;
        await before(init?.method ?? "GET", new URL(url).pathname);
        return send(input, init);
      }, sqlFor(before)),
    close,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} must be set to run against real PostgREST`);
  }
  return value;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function serviceRoleToken(secret: string): string {
  const signed = [
    base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64url(
      JSON.stringify({
        role: "bot_app",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  ].join(".");
  const signature = createHmac("sha256", secret)
    .update(signed)
    .digest("base64url");
  return `${signed}.${signature}`;
}

/**
 * PostgREST has no Supabase gateway in front of it, so this does the gateway's job:
 * it sends the request to the server's own path, with the JWT the gateway would mint.
 */
function fetchThroughPostgrest(baseUrl: string, secret: string): typeof fetch {
  const token = serviceRoleToken(secret);
  return (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const headers = new Headers(init?.headers);
    headers.delete("apikey");
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(
      `${baseUrl}${url.pathname.replace(/^\/rest\/v1/, "")}${url.search}`,
      { ...init, headers },
    );
  };
}

export async function openBackend(): Promise<Backend> {
  const postgrestUrl = process.env.POSTGREST_URL;
  if (postgrestUrl !== undefined && postgrestUrl !== "") {
    const connectionString = required("POSTGREST_DATABASE_URL");
    const client = new pg.Client({ connectionString });
    await client.connect();
    // One connection that stays bot_app, so the grants apply as they will in production.
    const botClient = new pg.Client({ connectionString });
    await botClient.connect();
    await botClient.query(`SET ROLE ${BOT_APP}`);
    const sql = drizzle({ client: botClient });
    return withBackend(
      fetchThroughPostgrest(postgrestUrl, required("PGRST_JWT_SECRET")),
      () => sql,
      pgConnection(client),
      () => Promise.all([client.end(), botClient.end()]),
    );
  }
  const database = await createMigratedDb();
  return withBackend(
    postgrestShim(database),
    (before) =>
      pgliteSql(
        database,
        before === undefined
          ? undefined
          : async (call) => {
              await before("SQL", call.sql);
              return undefined;
            },
      ),
    database,
    () => database.close(),
  );
}
