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
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * A Postgres URL for bot_app, with a password, a host and a database. Anything but a
 * local server must ask for TLS. Parsed with the URL parser alone, so no error can quote
 * the password.
 */
const DatabaseUrl = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const sslmode = url.searchParams.get("sslmode");
  return (
    (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
    decodeURIComponent(url.username) === DATABASE_ROLE &&
    url.password !== "" &&
    url.hostname !== "" &&
    /^\/[A-Za-z0-9_-]+$/.test(url.pathname) &&
    url.hash === "" &&
    (LOCAL_HOSTS.has(url.hostname) ||
      (sslmode !== null && TLS_MODES.has(sslmode)))
  );
});

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
  return read(
    "DATABASE_URL",
    DatabaseUrl,
    `must be a postgresql:// URL for ${DATABASE_ROLE}, with a password, a database and sslmode=require or stricter`,
  );
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
