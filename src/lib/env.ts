/**
 * Access to required settings. Each one is read and checked when it is needed,
 * so importing this module never fails and a route only depends on the settings
 * it uses. Errors name the setting and never include its value.
 */

import { z } from "zod";
import { ConfigError } from "./config-error.ts";
import { isSnowflake } from "./snowflake.ts";

const DiscordId = z.string().refine(isSnowflake);
// Anything else cannot go in a header, and HTTP clients quote the rejected header
// in their errors, which would print the token.
const BotToken = z.string().regex(/^[\x21-\x7e]+$/);
const PublicKey = z.string().regex(/^[0-9a-f]{64}$/i);
/** A malformed entry fails the whole list, so a typo cannot widen access. */
const GuildIds = z
  .string()
  .transform((list) => list.split(",").map((id) => id.trim()))
  .pipe(z.array(DiscordId))
  .transform((ids): ReadonlySet<string> => new Set(ids));

/** The bot's role. A connection string for any other is refused, the owner's above all. */
export const DATABASE_ROLE = "bot_app";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The only query parameters allowed, with the values each may take. pg copies every
 * query parameter into its config over what the rest of the URL says, so `?user=`,
 * `?password=`, `?host=`, `?port=` or `?options=` would connect as another role, to
 * another host or with other settings than the ones checked here. Neon's own strings
 * carry channel_binding, which pg ignores.
 */
const QUERY_VALUES = new Map<string, ReadonlySet<string>>([
  ["sslmode", new Set(["disable", "require", "verify-ca", "verify-full"])],
  ["channel_binding", new Set(["disable", "prefer", "require"])],
]);

type DatabaseUrlProblem = "malformed" | "weak_tls";

/**
 * Why a URL is refused, or null if it is a Postgres URL for bot_app with a password, a
 * host and a database. A non-local host must ask for sslmode=verify-full. pg 8 treats
 * require and verify-ca as verify-full but warns that pg 9 will follow libpq, where
 * neither checks the server's name, so they are refused rather than left to weaken on
 * an upgrade. Each query parameter may appear once: pg reads the last of a repeated
 * one, and this check would read the first. Parsed with the URL parser alone, so no
 * error can quote the password.
 */
function databaseUrlProblem(value: string): DatabaseUrlProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "malformed";
  }
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    [...url.searchParams].some(
      ([key, setting]) => QUERY_VALUES.get(key)?.has(setting) !== true,
    )
  ) {
    return "malformed";
  }
  const wellFormed =
    (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
    decodeURIComponent(url.username) === DATABASE_ROLE &&
    url.password !== "" &&
    url.hostname !== "" &&
    /^\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
    url.hash === "";
  if (!wellFormed) {
    return "malformed";
  }
  if (LOCAL_HOSTS.has(url.hostname)) {
    return null;
  }
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode === "verify-full") {
    return null;
  }
  return sslmode === "require" || sslmode === "verify-ca"
    ? "weak_tls"
    : "malformed";
}

/** Reads a setting. Zod's own messages are not used, so no error can quote a value. */
function read<T>(
  name: string,
  schema: z.ZodType<T, string>,
  problem: string,
): T {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(name, "must be set");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(name, problem);
  }
  return parsed.data;
}

export function getDatabaseUrl(): string {
  const name = "DATABASE_URL";
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(name, "must be set");
  }
  switch (databaseUrlProblem(value)) {
    case null:
      return value;
    case "weak_tls":
      throw new ConfigError(
        name,
        "must use sslmode=verify-full, not require or verify-ca: pg 9 will read those as libpq does, where they do not check the server's name, so a connection could go to an impostor",
      );
    case "malformed":
      throw new ConfigError(
        name,
        `must be a postgresql:// URL for ${DATABASE_ROLE}, with a password, a database, sslmode=verify-full for a non-local host, and no query parameters but sslmode and channel_binding, each once`,
      );
  }
}

export function getDiscordAppId(): string {
  return read("DISCORD_APP_ID", DiscordId, "must be a Discord ID");
}

export function getDiscordBotToken(): string {
  return read(
    "DISCORD_BOT_TOKEN",
    BotToken,
    "must contain only printable ASCII with no spaces",
  );
}

export function getDiscordPublicKey(): string {
  return read("DISCORD_PUBLIC_KEY", PublicKey, "must be 64 hex characters");
}

export function getAllowedGuildIds(): ReadonlySet<string> {
  return read(
    "ALLOWED_GUILD_IDS",
    GuildIds,
    "must be a comma-separated list of Discord IDs",
  );
}
