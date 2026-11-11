/**
 * Small guards for JSON a test reads from outside its own code: a file in the repository,
 * or a request body the code under test sent. Each throws with a short reason on the
 * wrong shape, so a test fails where it read the data and not somewhere later.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Parses text that must hold a JSON object. */
export function jsonObject(
  text: unknown,
  what: string,
): Record<string, unknown> {
  if (typeof text !== "string") {
    throw new Error(`${what} is not text`);
  }
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value;
}

export function recordAt(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} is not an object`);
  }
  return value;
}

export function stringAt(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string`);
  }
  return value;
}

export function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`${key} is not a number`);
  }
  return value;
}

/** A list of strings. `ifAbsent`, if given, stands in for a missing key. */
export function stringsAt(
  record: Record<string, unknown>,
  key: string,
  ifAbsent?: string[],
): string[] {
  const value = record[key] ?? ifAbsent;
  if (!isStringArray(value)) {
    throw new Error(`${key} is not a list of strings`);
  }
  return value;
}

/** A list of objects. `ifAbsent`, if given, stands in for a missing key. */
export function recordsAt(
  record: Record<string, unknown>,
  key: string,
  ifAbsent?: Record<string, unknown>[],
): Record<string, unknown>[] {
  const value = record[key] ?? ifAbsent;
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${key} is not a list of objects`);
  }
  return value;
}

export interface MessageBody {
  content: string;
  /** Undefined where the body sets no flags. */
  flags: number | undefined;
  users: string[];
  roles: string[];
  parse: string[];
  /** The custom IDs of every button, row by row. */
  buttons: string[];
}

/** The parts of a Discord message body the tests look at. */
export function messageBody(text: unknown): MessageBody {
  const body = jsonObject(text, "the message body");
  const mentions = recordAt(body, "allowed_mentions");
  return {
    content: stringAt(body, "content"),
    flags: body.flags === undefined ? undefined : numberAt(body, "flags"),
    users: stringsAt(mentions, "users"),
    roles: stringsAt(mentions, "roles", []),
    parse: stringsAt(mentions, "parse"),
    buttons: recordsAt(body, "components", []).flatMap((row) =>
      recordsAt(row, "components").map((button) =>
        stringAt(button, "custom_id"),
      ),
    ),
  };
}

export interface VercelConfig {
  crons: { path: string; schedule: string }[];
  functions: Record<string, { maxDuration: number }>;
}

/** The parts of vercel.json the tests check. */
export function vercelConfig(text: string): VercelConfig {
  const config = jsonObject(text, "vercel.json");
  const functions = recordAt(config, "functions");
  return {
    crons: recordsAt(config, "crons").map((cron) => ({
      path: stringAt(cron, "path"),
      schedule: stringAt(cron, "schedule"),
    })),
    functions: Object.fromEntries(
      Object.keys(functions).map((name) => [
        name,
        { maxDuration: numberAt(recordAt(functions, name), "maxDuration") },
      ]),
    ),
  };
}
