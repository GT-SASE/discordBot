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
