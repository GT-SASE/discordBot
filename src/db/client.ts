/**
 * The server-side database client. It is built on first use, so importing this file
 * never reads a secret or fails. postgrest-js has no auth module, so there is no
 * session to persist or refresh.
 */

import { PostgrestClient } from "@supabase/postgrest-js";
import { ConfigError } from "../lib/config-error.ts";
import { getDatabaseUrl } from "../lib/env.ts";
import {
  rebuildWithDeadline,
  registerClient,
  sqlDatabase,
  type DbClient,
  type RestClient,
  type SqlDatabase,
} from "./internal.ts";
import { closePool, poolDatabase } from "./pool.ts";
import type { Database } from "./types.ts";

export type { DbClient, SqlDatabase };

export interface DbSettings {
  readonly url: string;
  readonly secretKey: string;
  /** Replaces the network layer, for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Where the queries built with Drizzle go. See `poolDatabase`. */
  readonly sql: SqlDatabase;
}

/**
 * Closes the connections of a client from `createDbFromEnv`, and of every client made
 * from it with `withDeadline`. For a caller done with the client, so a warm instance
 * keeps no connection between runs. Does nothing for any other client.
 */
export async function closeDb(db: DbClient): Promise<void> {
  await closePool(sqlDatabase(db));
}

const SECRET_KEY = /^sb_secret_[\x21-\x7e]+$/;
const DEFAULT_DEADLINE_MS = 8000;

/**
 * For a request Discord is waiting on. Discord allows 3 seconds for the first reply,
 * and this leaves time for a fixed reply if the read fails. An interaction handler
 * makes one such read and defers anything more.
 */
export const INTERACTION_DEADLINE_MS = 1500;

function projectOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("SUPABASE_URL", "must be a URL");
  }
  // The whole URL must be the origin, so credentials, a path, a query or a fragment
  // all fail this one comparison.
  if (url.protocol !== "https:" || url.href !== `${url.origin}/`) {
    throw new ConfigError(
      "SUPABASE_URL",
      "must be an https origin with no path, query or credentials",
    );
  }
  return url.origin;
}

export function createDbClient(settings: DbSettings): DbClient {
  if ("window" in globalThis || "document" in globalThis) {
    throw new Error("The database client is server-side only");
  }
  const { url, secretKey, fetch: send = globalThis.fetch, sql } = settings;
  const origin = projectOrigin(url);
  if (!SECRET_KEY.test(secretKey)) {
    throw new ConfigError(
      "SUPABASE_SECRET_KEY",
      "must be a Supabase server-side secret key",
    );
  }

  const build = (deadlineMs: number): RestClient =>
    new PostgrestClient<Database>(`${origin}/rest/v1`, {
      // These keys are not JWTs, so they go in this header and not in Authorization.
      headers: { apikey: secretKey },
      schema: "public",
      // The caller decides whether to try again, within its own time budget.
      retry: false,
      // A redirect would carry the key's header to another host.
      fetch: (input, init) =>
        send(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(deadlineMs),
        }),
    });

  const register = (deadlineMs: number): DbClient =>
    registerClient({
      client: build(deadlineMs),
      sql,
      deadlineMs,
      withDeadline: register,
    });

  return register(DEFAULT_DEADLINE_MS);
}

/**
 * The same client with a shorter limit on each request. A request over the limit is
 * abandoned and fails as `unavailable`, though the database may still finish it.
 */
export function withDeadline(db: DbClient, deadlineMs: number): DbClient {
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > DEFAULT_DEADLINE_MS
  ) {
    throw new RangeError("Deadline out of range");
  }
  return rebuildWithDeadline(db, deadlineMs);
}

/** A new client from the environment's settings, shared with no other caller. */
export function createDbFromEnv(): DbClient {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (url === undefined || url === "") {
    throw new ConfigError("SUPABASE_URL", "must be set");
  }
  if (secretKey === undefined || secretKey === "") {
    throw new ConfigError("SUPABASE_SECRET_KEY", "must be set");
  }
  return createDbClient({
    url,
    secretKey,
    sql: poolDatabase(getDatabaseUrl()),
  });
}

let client: DbClient | undefined;

/** One client for the life of the function instance, for interaction handlers. */
export function getDb(): DbClient {
  client ??= createDbFromEnv();
  return client;
}

/** The client for a handler that has not deferred. See `INTERACTION_DEADLINE_MS`. */
export function getInteractionDb(): DbClient {
  return withDeadline(getDb(), INTERACTION_DEADLINE_MS);
}
