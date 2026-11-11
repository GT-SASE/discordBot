import { afterEach, describe, expect, it, vi } from "vitest";
import { testSnowflake } from "../../test/support/mock-db.ts";
import {
  recordingSql,
  serverError,
  testDatabaseUrl,
} from "../../test/support/sql-client.ts";
import { getGuildConfig } from "./guild-config.ts";
import { claimInteraction } from "./interaction-claims.ts";
import { markTaskDoneAsOfficer } from "./tasks.ts";
import type { DateOnly } from "../lib/dates.ts";
import type { EventResource, TaskResource } from "../lib/permissions.ts";
import {
  INTERACTION_DEADLINE_MS,
  createDbClient,
  withDeadline,
  type DbClient,
} from "./client.ts";
import { errorSummary, failureFromError, isDeadConnection } from "./errors.ts";
import {
  cappedList,
  functionValue,
  jsonRows,
  oneOrNone,
  rowList,
} from "./result.ts";
import { parseJobRun, parseTask } from "./types.ts";
import {
  MAX_SEARCH_LENGTH,
  isDbDate,
  isSearchTerm,
  isSnowflakeList,
  isStoredText,
  isTimestampText,
  isUuid,
  searchPattern,
  snowflakeList,
  uuidList,
} from "./validate.ts";

const UUID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("client", () => {
  const sql = () => recordingSql().sql;

  it("abandons a query at its deadline and reports it as unavailable", async () => {
    const { sql: hanging } = recordingSql(
      () => new Promise<never>(() => undefined),
    );
    const db = withDeadline(createDbClient(hanging), 10);
    const started = Date.now();
    expect(await getGuildConfig(db, { guildId: testSnowflake() })).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps interaction calls inside Discord's first reply window", () => {
    expect(INTERACTION_DEADLINE_MS).toBeLessThan(2500);
  });

  it.each([0, -1, 1.5, Number.NaN, 8001])(
    "refuses the deadline %d",
    (deadline) => {
      const db = createDbClient(sql());
      expect(() => withDeadline(db, deadline)).toThrow(RangeError);
    },
  );

  it("gives code outside src/db nothing to query with", () => {
    const db: DbClient = createDbClient(sql());
    // @ts-expect-error the client is opaque outside src/db
    expect(db.select).toBeUndefined();
    // @ts-expect-error the client is opaque outside src/db
    expect(db.execute).toBeUndefined();
  });

  it("refuses an object that is not a client", async () => {
    await expect(
      getGuildConfig({} as DbClient, { guildId: testSnowflake() }),
    ).rejects.toThrow(TypeError);
  });

  it("does not retry a query the server refused", async () => {
    const { sql: failing, calls } = recordingSql(() => serverError("57P01"));
    await getGuildConfig(createDbClient(failing), { guildId: testSnowflake() });
    expect(calls).toHaveLength(1);
  });

  it("sends a read once more after its connection died, and returns the second answer", async () => {
    let sent = 0;
    const { sql: thawed, calls } = recordingSql(() => {
      sent += 1;
      return sent === 1
        ? new Error("Connection terminated unexpectedly")
        : { rows: [] };
    });
    expect(
      await getGuildConfig(createDbClient(thawed), {
        guildId: testSnowflake(),
      }),
    ).toEqual({ ok: true, value: null });
    expect(calls).toHaveLength(2);
  });

  it("tries a read only twice on a connection that keeps dying", async () => {
    const { sql: dead, calls } = recordingSql(() =>
      Object.assign(new Error("canary"), { code: "ECONNRESET" }),
    );
    expect(
      await getGuildConfig(createDbClient(dead), { guildId: testSnowflake() }),
    ).toEqual({ ok: false, error: { category: "unavailable", code: null } });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a read that timed out or a programming error", async () => {
    for (const error of [new Error("Query read timeout"), new TypeError("x")]) {
      const { sql: failing, calls } = recordingSql(() => error);
      await getGuildConfig(createDbClient(failing), {
        guildId: testSnowflake(),
      });
      expect(calls).toHaveLength(1);
    }
  });

  it("never sends a write or a function call twice after its connection died", async () => {
    const dying = () => {
      const recorded = recordingSql(
        () => new Error("Connection terminated unexpectedly"),
      );
      return { db: createDbClient(recorded.sql), calls: recorded.calls };
    };
    const update = dying();
    expect(
      await markTaskDoneAsOfficer(update.db, {
        guildId: testSnowflake(),
        taskId: "11111111-2222-4333-8444-555555555555",
        now: new Date(),
      }),
    ).toMatchObject({ ok: false, error: { category: "unavailable" } });
    expect(update.calls).toHaveLength(1);

    const call = dying();
    expect(
      await claimInteraction(call.db, { interactionId: testSnowflake() }),
    ).toMatchObject({ ok: false, error: { category: "unavailable" } });
    expect(call.calls).toHaveLength(1);
  });

  it("reports a refused connection as unavailable, with no text from the error", async () => {
    const canary = "canary-host-and-password";
    const { sql: refusing } = recordingSql(() =>
      Object.assign(new Error(canary), { code: "ECONNREFUSED" }),
    );
    const result = await getGuildConfig(createDbClient(refusing), {
      guildId: testSnowflake(),
    });
    expect(result).toEqual({
      ok: false,
      error: { category: "unavailable", code: null },
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("refuses to run where a browser global exists", () => {
    vi.stubGlobal("window", {});
    expect(() => createDbClient(sql())).toThrow("server-side only");
  });

  it("reads its setting on first use, not on import, and reuses one client", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getDb } = await import("./client.ts");
    expect(() => getDb()).toThrow("DATABASE_URL");

    vi.stubEnv("DATABASE_URL", testDatabaseUrl());
    expect(getDb()).toBe(getDb());
  });
});

describe("errors from the driver", () => {
  const canary = "canary-row-text";

  it("keeps only a category and the SQLSTATE of a server error", () => {
    const error = Object.assign(new Error(`failing row contains ${canary}`), {
      code: "23514",
      severity: "ERROR",
      detail: canary,
    });
    expect(failureFromError(error)).toEqual({
      ok: false,
      error: { category: "constraint", code: "23514" },
    });
    expect(errorSummary(failureFromError(error).error)).toBe(
      "constraint:23514",
    );
  });

  it("reads the code under Drizzle's wrapper, whose message quotes the query", () => {
    const cause = Object.assign(new Error("row text"), {
      code: "CF409",
      severity: "ERROR",
    });
    const wrapped = Object.assign(new Error(`Failed query: select ${canary}`), {
      cause,
    });
    const result = failureFromError(wrapped);
    expect(result.error).toEqual({ category: "stale_version", code: "CF409" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    ["CF410", "parent_unavailable"],
    ["CF412", "task_changed"],
    ["CF429", "event_task_limit"],
    ["CF430", "actor_task_limit"],
    ["CF431", "step_assignee_limit"],
    ["23505", "conflict"],
    ["42501", "forbidden"],
    ["28P01", "forbidden"],
    ["28000", "forbidden"],
    ["57014", "unavailable"],
    ["08006", "unavailable"],
    ["53300", "unavailable"],
    ["XX000", "unavailable"],
    ["42601", "unexpected"],
  ])("maps %s to %s", (code, category) => {
    expect(
      failureFromError(
        Object.assign(new Error(canary), { code, severity: "ERROR" }),
      ).error,
    ).toEqual({ category, code });
  });

  it.each([
    [
      "a refused connection",
      Object.assign(new Error(canary), { code: "ECONNREFUSED" }),
    ],
    [
      "a short network code",
      Object.assign(new Error(canary), { code: "EPIPE" }),
    ],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    [
      "a connection that could not be made in time",
      new Error("timeout expired"),
    ],
    ["a full pool", new Error("timeout exceeded when trying to connect")],
    ["a timeout", new Error("Query read timeout")],
  ])("reports %s as unavailable, with no code or text", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unavailable", code: null });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    ["a TypeError", new TypeError(canary)],
    ["a plain error with no code", new Error(canary)],
    [
      "a programming error under Drizzle's wrapper",
      Object.assign(new Error(`Failed query: ${canary}`), {
        cause: new RangeError(canary),
      }),
    ],
  ])("reports %s as unexpected, with no code or text", (_name, error) => {
    const result = failureFromError(error);
    expect(result.error).toEqual({ category: "unexpected", code: null });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it.each([
    [
      "a dropped connection",
      new Error("Connection terminated unexpectedly"),
      true,
    ],
    [
      "a reset socket",
      Object.assign(new Error(canary), { code: "ECONNRESET" }),
      true,
    ],
    [
      "a broken pipe",
      Object.assign(new Error(canary), { code: "EPIPE" }),
      true,
    ],
    [
      "a dropped connection under Drizzle's wrapper",
      Object.assign(new Error(`Failed query: ${canary}`), {
        cause: new Error("Connection terminated unexpectedly"),
      }),
      true,
    ],
    [
      "a refused connection",
      Object.assign(new Error(canary), { code: "ECONNREFUSED" }),
      false,
    ],
    ["a timeout", new Error("Query read timeout"), false],
    ["a programming error", new TypeError(canary), false],
    [
      "an error from the server",
      Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "57P01",
        severity: "FATAL",
      }),
      false,
    ],
  ])("tells whether %s is a dead connection", (_name, error, dead) => {
    expect(isDeadConnection(error)).toBe(dead);
  });

  it("refuses a value that is not an error at all", () => {
    expect(failureFromError("text").error).toEqual({
      category: "unexpected",
      code: null,
    });
  });
});

describe("row checks", () => {
  const goodTask = {
    id: UUID,
    event_id: UUID,
    guild_id: testSnowflake(),
    assignee_id: testSnowflake(),
    description: "Book the room",
    due_date: "2030-01-10",
    status: "open",
    completed_at: null,
    created_by: testSnowflake(),
    deleted_at: null,
    updated_at: "2030-01-01T12:00:00.123456+00:00",
  };
  const response = (data: unknown) => ({
    ok: true as const,
    value: data as readonly unknown[],
  });

  it("reads a good row with a real date", () => {
    const parsed = parseTask(goodTask);
    expect(parsed).toMatchObject({
      ok: true,
      row: { id: UUID, due_date: "2030-01-10" },
    });
  });

  it.each([
    ["due_date", "2030-02-30"],
    ["due_date", "infinity"],
    ["due_date", null],
    ["status", "archived"],
    ["guild_id", "12"],
    ["id", "not-a-uuid"],
    ["completed_at", "yesterday"],
    ["description", 7],
  ])("excludes a row with %s = %j and names the field", (field, value) => {
    const list = rowList(
      response([goodTask, { ...goodTask, [field]: value }]),
      parseTask,
    );
    expect(list).toMatchObject({
      ok: true,
      value: {
        rows: [{ id: UUID }],
        excluded: [{ table: "tasks", field }],
      },
    });
  });

  it("reports an excluded row without any of its text", () => {
    const list = rowList(
      response([{ ...goodTask, description: "secret words", due_date: "bad" }]),
      parseTask,
    );
    expect(JSON.stringify(list)).not.toContain("secret words");
  });

  it("gives rows the column names authorization works from", () => {
    const parsed = parseTask(goodTask);
    if (!parsed.ok) {
      throw new Error("expected a good row");
    }
    const task: TaskResource = parsed.row;
    const event: EventResource = parsed.row;
    expect(task.assignee_id).toBe(goodTask.assignee_id);
    expect(event.deleted_at).toBeNull();
  });

  it("keeps a timestamp as the exact text, to send back as an expected value", () => {
    expect(parseTask(goodTask)).toMatchObject({
      row: { updated_at: "2030-01-01T12:00:00.123456+00:00" },
    });
  });

  it("caps a list and says when there were more rows", () => {
    const row = goodTask;
    const over = cappedList(response([row, row, row]), parseTask, 2);
    expect(over.ok && over.value.rows).toHaveLength(2);
    expect(over.ok && over.value.truncated).toBe(true);
    const exact = cappedList(response([row, row]), parseTask, 2);
    expect(exact.ok && exact.value.rows).toHaveLength(2);
    expect(exact.ok && exact.value.truncated).toBe(false);
  });

  it("reads inherited properties as missing", () => {
    const row: unknown = Object.create({ ...goodTask });
    expect(parseTask(row).ok).toBe(false);
  });

  it("excludes things that are not rows", () => {
    const list = rowList(response([null, 3, "x", []]), parseTask);
    expect(list).toMatchObject({ ok: true, value: { rows: [] } });
    expect(list.ok && list.value.excluded).toHaveLength(4);
  });

  it("treats a bad row on a read by key as a failure", () => {
    expect(oneOrNone(response([{ id: UUID }]), parseTask)).toEqual({
      ok: false,
      error: { category: "bad_row", code: null },
    });
  });

  it("treats a function's answer that is not a list of rows as a failure", () => {
    expect(jsonRows({ ok: true, value: { id: UUID } }).ok).toBe(false);
    expect(jsonRows({ ok: true, value: [] })).toEqual({ ok: true, value: [] });
  });

  it("reads a function's value from its one row, and nothing else", () => {
    expect(
      functionValue({ ok: true, value: { rows: [{ value: 3 }] } }),
    ).toEqual({ ok: true, value: 3 });
    for (const value of [
      { rows: [] },
      { rows: [{ value: 1 }, { value: 2 }] },
      { rows: [{ other: 1 }] },
      { rows: "x" },
      null,
    ]) {
      expect(functionValue({ ok: true, value }).ok).toBe(false);
    }
  });

  it("requires job results to be an object", () => {
    expect(parseJobRun({ results: [] }).ok).toBe(false);
  });
});

describe("input checks", () => {
  it.each([UUID])("accepts the UUID %s", (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    "",
    "x",
    `${UUID} `,
    `${UUID},`,
    `${UUID}"`,
    "AAAAAAAA-2222-4333-8444-555555555555",
    `${UUID}\n`,
    null,
    7,
  ])("refuses the UUID %j", (value) => {
    expect(isUuid(value)).toBe(false);
  });

  it.each(["2000-01-01", "9999-12-31", "2030-02-28"])(
    "accepts the date %s",
    (value) => {
      expect(isDbDate(value)).toBe(true);
    },
  );

  it.each([
    "1999-12-31",
    "2030-02-30",
    "infinity",
    "2030-1-1",
    "2030-01-01T00:00:00Z",
    "",
  ])("refuses the date %s", (value) => {
    expect(isDbDate(value)).toBe(false);
  });

  it("refuses blank text, NUL, lone surrogates and overlong text", () => {
    expect(isStoredText("ok", 10)).toBe(true);
    expect(isStoredText("  ", 10)).toBe(false);
    expect(isStoredText("a\u0000b", 10)).toBe(false);
    expect(isStoredText("a\ud800b", 10)).toBe(false);
    expect(isStoredText("a\udc00", 10)).toBe(false);
    expect(isStoredText("12345678901", 10)).toBe(false);
  });

  it("counts an astral character as two against a limit", () => {
    expect(isStoredText("\u{1F389}".repeat(5), 10)).toBe(true);
    expect(isStoredText("\u{1F389}".repeat(6), 10)).toBe(false);
  });

  it("refuses search terms with NUL or a lone surrogate", () => {
    expect(isSearchTerm("a,b)c")).toBe(true);
    expect(isSearchTerm("")).toBe(true);
    expect(isSearchTerm("a\u0000")).toBe(false);
    expect(isSearchTerm("\ud800")).toBe(false);
  });

  it.each([
    ["plain", "%plain%"],
    ["50%", "%50\\%%"],
    ["a_b", "%a\\_b%"],
    ["a*b", "%a*b%"],
    ["a\\b", "%a\\\\b%"],
    ['a,b).c"', '%a,b).c"%'],
    ["", "%%"],
  ])("builds a literal pattern from %j", (term, pattern) => {
    expect(searchPattern(term)).toBe(pattern);
  });

  it("caps the term in code points without splitting a pair", () => {
    const pattern = searchPattern("\u{1F389}".repeat(MAX_SEARCH_LENGTH + 50));
    expect(pattern.isWellFormed()).toBe(true);
    expect(Array.from(pattern.slice(1, -1))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(searchPattern("a".repeat(6000))).toHaveLength(MAX_SEARCH_LENGTH + 2);
  });

  it.each([
    "2030-01-01T12:00:00+00:00",
    "2030-01-01T12:00:00.123456+00:00",
    "2030-01-01T12:00:00Z",
  ])("accepts the timestamp %s", (value) => {
    expect(isTimestampText(value)).toBe(true);
  });

  it.each([
    "",
    "2030-01-01",
    "yesterday",
    "2030-13-01T12:00:00Z",
    "2030-01-01T12:00:00Z,x",
    "2030-01-01T12:00:00Z\n",
    null,
  ])("refuses the timestamp %j", (value) => {
    expect(isTimestampText(value)).toBe(false);
  });

  it("refuses an ID list holding a crafted value", () => {
    const good = testSnowflake();
    const crafted = 'x","y';
    expect(isSnowflakeList([good])).toBe(true);
    expect(isSnowflakeList([good, crafted])).toBe(false);
    expect(() => snowflakeList([good, crafted])).toThrow(RangeError);
    expect(() => uuidList([UUID, crafted])).toThrow(RangeError);
    expect(snowflakeList([good])).toEqual([good]);
    expect(uuidList([UUID])).toEqual([UUID]);
  });

  it("refuses a list that is too long", () => {
    const ids = Array.from({ length: 101 }, () => testSnowflake());
    expect(isSnowflakeList(ids)).toBe(false);
    expect(() => snowflakeList(ids)).toThrow(RangeError);
  });

  it("brands a checked date", () => {
    const value: unknown = "2030-01-01";
    if (isDbDate(value)) {
      const date: DateOnly = value;
      expect(date).toBe("2030-01-01");
    }
  });
});
