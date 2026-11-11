import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config-error.ts";
import {
  getAllowedGuildIds,
  getDatabaseUrl,
  getDiscordAppId,
  getDiscordBotToken,
  getDiscordPublicKey,
} from "./env.ts";

const GUILD_A = "1".repeat(18);
const GUILD_B = "2".repeat(18);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("required settings", () => {
  it.each([
    ["DISCORD_APP_ID", getDiscordAppId],
    ["DISCORD_BOT_TOKEN", getDiscordBotToken],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds],
  ])("refuses a missing or blank %s", (name, read) => {
    vi.stubEnv(name, undefined);
    expect(read).toThrow(ConfigError);

    vi.stubEnv(name, "   ");
    expect(read).toThrow(ConfigError);
  });

  it.each([
    ["DISCORD_APP_ID", getDiscordAppId],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds],
  ])("names %s but not its rejected value", (name, read) => {
    const canary = "canary-value-that-must-stay-private";
    vi.stubEnv(name, canary);

    expect(read).toThrow(name);
    expect(read).not.toThrow(canary);
  });
});

describe("getDiscordBotToken", () => {
  it("accepts printable ASCII", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "abc.DEF-123_~");
    expect(getDiscordBotToken()).toBe("abc.DEF-123_~");
  });

  it("ignores surrounding whitespace, such as a final newline", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "abc.DEF\n");
    expect(getDiscordBotToken()).toBe("abc.DEF");
  });

  it.each([
    ["an interior newline", "canary-head\ncanary-tail"],
    ["an interior space", "canary-head canary-tail"],
    ["a control character", "canary-head\x7fcanary-tail"],
    ["a non-ASCII character", "canary-headécanary-tail"],
  ])("refuses %s without quoting the value", (_label, token) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", token);

    expect(getDiscordBotToken).toThrow(ConfigError);
    expect(getDiscordBotToken).toThrow("DISCORD_BOT_TOKEN");
    expect(getDiscordBotToken).not.toThrow("canary");
  });
});

describe("getDiscordPublicKey", () => {
  it("accepts 32 bytes of hex", () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", "ab".repeat(32));
    expect(getDiscordPublicKey()).toBe("ab".repeat(32));
  });

  it("refuses the wrong length", () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", "ab".repeat(31));
    expect(getDiscordPublicKey).toThrow(ConfigError);
  });
});

describe("getAllowedGuildIds", () => {
  it("splits and trims the list", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A}, ${GUILD_B}`);
    expect(getAllowedGuildIds()).toEqual(new Set([GUILD_A, GUILD_B]));
  });

  it("fails the whole list when one entry is malformed", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},not-an-id`);
    expect(getAllowedGuildIds).toThrow(ConfigError);
  });

  it("refuses an empty entry", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},`);
    expect(getAllowedGuildIds).toThrow(ConfigError);
  });
});

describe("DATABASE_URL", () => {
  // The user and password are set on a parsed URL, so no credential-shaped text is
  // tracked.
  const password = ["placeholder", "only"].join("-");
  const url = (rest: string, user = "bot_app") => {
    const parsed = new URL(`postgresql://${rest}`);
    parsed.username = user;
    parsed.password = password;
    return parsed.toString();
  };

  it.each([
    url("ep-example-pooler.example.test/bot?sslmode=require"),
    url(
      "ep-example-pooler.example.test/bot?sslmode=verify-full&channel_binding=require",
    ),
    url("localhost:5432/bot"),
    url("127.0.0.1/bot").replace("postgresql:", "postgres:"),
  ])("accepts %s", (value) => {
    vi.stubEnv("DATABASE_URL", value);
    expect(getDatabaseUrl()).toBe(value);
  });

  it.each([
    [
      "the owner's role",
      url("db.example.test/bot?sslmode=require", "neondb_owner"),
    ],
    ["no password", "postgresql://bot_app@db.example.test/bot?sslmode=require"],
    ["no TLS to a remote host", url("db.example.test/bot")],
    ["TLS that may be skipped", url("db.example.test/bot?sslmode=prefer")],
    ["no database", url("db.example.test/?sslmode=require")],
    [
      "another scheme",
      url("db.example.test/bot?sslmode=require").replace(
        "postgresql:",
        "https:",
      ),
    ],
    ["no URL at all", "bot_app"],
  ])("refuses %s, naming only the setting", (_name, value) => {
    vi.stubEnv("DATABASE_URL", value);
    expect(getDatabaseUrl).toThrow(ConfigError);
    expect(getDatabaseUrl).toThrow("DATABASE_URL");
    expect(getDatabaseUrl).not.toThrow(password);
  });

  it("refuses it missing or blank", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(getDatabaseUrl).toThrow("must be set");
    vi.stubEnv("DATABASE_URL", "  ");
    expect(getDatabaseUrl).toThrow("must be set");
  });
});
