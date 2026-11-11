// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as endpoint from "../../api/cron/reminders.ts";
import { vercelConfig } from "../../test/support/json.ts";
import {
  serverError,
  sqlTarget,
  testDatabaseUrl,
} from "../../test/support/sql-client.ts";
import { STALE_CLAIM_MS } from "./plan.ts";
import {
  DATABASE_CALL_MS,
  DISCORD_OPERATION_MS,
  LOCK_STALE_SECONDS,
  RUN_HARD_STOP_MS,
  RUN_WORK_MS,
} from "./run.ts";

const SECRET = "c".repeat(40);
const URL_BASE = "https://bot.example.test/api/cron/reminders";
const ROOT = join(import.meta.dirname, "..", "..");
const RUN_ID = "00000000-0000-4000-8000-000000000001";
/** claim_reminders' answer for one reminder, claimed. */
const CLAIMED_ONE = [{ claim_token: RUN_ID, changed: false }];

function get(
  headers: Record<string, string> = {},
  query = "",
): Promise<Response> {
  return endpoint.GET(new Request(`${URL_BASE}${query}`, { headers }));
}

const fetchMock = vi.fn<typeof fetch>();

const clients = vi.hoisted(() => ({
  options: [] as unknown[],
  made: [] as unknown[],
}));
const databases = vi.hoisted(() => ({ made: [] as unknown[] }));

vi.mock("../discord/client.ts", async (original) => {
  const actual = await original<typeof import("../discord/client.ts")>();
  return {
    ...actual,
    createDiscordClient: (
      options: Parameters<typeof actual.createDiscordClient>[0],
    ) => {
      clients.options.push(options);
      const client = actual.createDiscordClient(options);
      clients.made.push(client);
      return client;
    },
  };
});

/** What the database answers the reads built with Drizzle. Each test may replace it. */
const sqlReads = vi.hoisted(() => ({
  answer: (call: { sql: string }): unknown => ({ rows: [], sql: call.sql }),
  /** What each statement did, as `select <table>` or `call <function>`. */
  targets: [] as string[],
}));

/** Each database the run made, and the close of its pool. */
const pools = vi.hoisted(() => ({
  closePool: vi.fn<(database: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  made: [] as unknown[],
}));

vi.mock("../db/pool.ts", async () => {
  const { recordingSql } = await import("../../test/support/sql-client.ts");
  return {
    poolDatabase: () => {
      const { sql } = recordingSql(
        (call) => sqlReads.answer(call) as { rows: unknown[] },
      );
      pools.made.push(sql);
      return sql;
    },
    closePool: pools.closePool,
  };
});

vi.mock("../db/client.ts", async (original) => {
  const actual = await original<typeof import("../db/client.ts")>();
  return {
    ...actual,
    createDbFromEnv: () => {
      const db = actual.createDbFromEnv();
      databases.made.push(db);
      return db;
    },
  };
});

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("unauthorized");
  expect(fetchMock).not.toHaveBeenCalled();
}

const GUILD = (10n ** 17n + 1n).toString();
const THREAD = (10n ** 17n + 2n).toString();
const FORUM = (10n ** 17n + 4n).toString();

/** A task due in two days, in an event with a post, as the candidates read returns it. */
function candidateRow() {
  return {
    id: RUN_ID,
    event_id: RUN_ID,
    guild_id: GUILD,
    assignee_id: (10n ** 17n + 3n).toString(),
    description: "Book",
    due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    status: "open",
    updated_at: "2030-01-01T00:00:00.000000+00:00",
    events: {
      id: RUN_ID,
      name: "Meeting",
      thread_id: THREAD,
      status: "active",
      thread_status: "active",
      thread_refusals: 0,
      managed_channels: { guild_config: { timezone: "UTC" } },
    },
    reminder_log: [],
  };
}

/** The candidate as the planner's read returns it: the selected values, in order. */
function candidateValues(): unknown[] {
  const row = candidateRow();
  return [
    row.id,
    row.event_id,
    row.guild_id,
    row.assignee_id,
    row.description,
    row.due_date,
    row.status,
    row.updated_at,
    ...Object.values(row.events),
    row.reminder_log,
  ];
}

/** The value each database function answers with, when the run gets the lock. */
function functionAnswer(name: string, locked: boolean): unknown {
  switch (name) {
    case "begin_job_run":
      return locked ? null : RUN_ID;
    case "expire_interaction_claims":
      return 0;
    case "claim_reminders":
      return CLAIMED_ONE;
    case "finish_job_run":
      return [jobRow("succeeded", null)];
    case "mark_reminders_sent":
      return [true];
    default:
      return name.startsWith("claim_") ? RUN_ID : true;
  }
}

/**
 * Answers the database: one candidate task if asked, this forum, a succeeded run, and
 * each function's usual answer. With `locked`, another run holds the job's lock.
 */
function reads({
  candidate = false,
  forum,
  locked = false,
}: {
  candidate?: boolean;
  forum?: string | undefined;
  locked?: boolean;
} = {}) {
  return ({ sql }: { sql: string }) => {
    const target = sqlTarget(sql);
    sqlReads.targets.push(target);
    if (target.startsWith("call ")) {
      return {
        rows: [{ value: functionAnswer(target.slice("call ".length), locked) }],
      };
    }
    const forumRows = forum === undefined ? [] : [[GUILD, FORUM, forum]];
    if (target === "select tasks") {
      return { rows: candidate ? [candidateValues()] : [] };
    }
    if (target === "select managed_channels") {
      return { rows: forumRows };
    }
    if (target === "select events" && sql.includes('join "managed_channels"')) {
      return { rows: sql.includes('"thread_id" = $') ? forumRows : [] };
    }
    if (target === "select job_runs") {
      return { rows: [Object.values(jobRow("succeeded", null))] };
    }
    return { rows: [] };
  };
}

function jobRow(status: string, error: string | null) {
  return {
    id: RUN_ID,
    job_name: "reminders",
    status,
    started_at: "2026-11-04T14:00:00.000Z",
    heartbeat_at: "2026-11-04T14:00:00.000Z",
    finished_at: "2026-11-04T14:00:01.000Z",
    results: {},
    error,
  };
}

beforeEach(() => {
  clients.options = [];
  clients.made = [];
  databases.made = [];
  pools.made = [];
  pools.closePool.mockReset();
  pools.closePool.mockImplementation(() => Promise.resolve());
  sqlReads.answer = reads();
  sqlReads.targets = [];
  vi.stubEnv("DATABASE_URL", testDatabaseUrl());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  vi.stubEnv("DISCORD_APP_ID", (10n ** 17n).toString());
  vi.stubEnv("ALLOWED_GUILD_IDS", (10n ** 17n + 1n).toString());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refusals", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "c".repeat(31)],
  ])(
    "refuses before any database call when the secret is %s",
    async (_label, secret) => {
      vi.stubEnv("CRON_SECRET", secret);
      for (const headers of [
        {},
        { authorization: "Bearer undefined" },
        { authorization: `Bearer ${String(secret)}` },
      ]) {
        await expectRefused(await get(headers));
      }
    },
  );

  it("refuses a wrong secret", async () => {
    await expectRefused(
      await get({ authorization: `Bearer ${"d".repeat(40)}` }),
    );
  });

  it("refuses Bearer undefined with a real secret set", async () => {
    await expectRefused(await get({ authorization: "Bearer undefined" }));
  });

  it("refuses spoofed cron headers and a cron user agent", async () => {
    await expectRefused(
      await get({
        "x-vercel-cron": "1",
        "x-vercel-cron-schedule": "0 15 * * *",
        "x-vercel-id": "abc",
        "user-agent": "vercel-cron/1.0",
      }),
    );
  });

  it.each(["secret", "token", "authorization", "CRON_SECRET"])(
    "refuses the secret in the query string as ?%s=",
    async (name) => {
      await expectRefused(await get({}, `?${name}=${SECRET}`));
      // A handler falling back to the query would compare it with the whole header value.
      await expectRefused(await get({}, `?${name}=Bearer%20${SECRET}`));
    },
  );

  it("gives every refusal the same body", async () => {
    const bodies = new Set<string>();
    for (const headers of [
      {},
      { authorization: "Bearer undefined" },
      { authorization: `Bearer ${"d".repeat(40)}` },
    ]) {
      bodies.add(await (await get(headers)).text());
    }
    vi.stubEnv("CRON_SECRET", undefined);
    bodies.add(await (await get()).text());
    expect([...bodies]).toEqual(["unauthorized"]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "c".repeat(31)],
  ])("logs one fixed line when the secret is %s", async (_label, secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await get({ authorization: `Bearer ${SECRET}` });
    expect(error.mock.calls).toEqual([["Cron secret is unset or too short"]]);
  });

  it("logs nothing for a wrong header", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await get({ authorization: `Bearer ${"d".repeat(40)}` });
    await get();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("offers GET and nothing else", () => {
    expect(Object.keys(endpoint)).toEqual(["GET"]);
  });
});

describe("an authorized request", () => {
  const authorized = { authorization: `Bearer ${SECRET}` };

  it("returns a fixed body when another run holds the lock", async () => {
    sqlReads.answer = reads({ locked: true });
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sqlReads.targets).toContain("call begin_job_run");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the same fixed body after a real run", async () => {
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("closes the run's pool once after a run that succeeded", async () => {
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(pools.made).toHaveLength(1);
    expect(pools.closePool).toHaveBeenCalledTimes(1);
    expect(pools.closePool).toHaveBeenCalledWith(pools.made[0]);
  });

  it("closes the run's pool once after a run that failed", async () => {
    sqlReads.answer = () => serverError("XX000");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await get(authorized);
    expect(response.status).toBe(500);
    expect(pools.made).toHaveLength(1);
    expect(pools.closePool).toHaveBeenCalledTimes(1);
    expect(pools.closePool).toHaveBeenCalledWith(pools.made[0]);
  });

  it("still answers when closing the pool hangs", async () => {
    pools.closePool.mockImplementation(
      () => new Promise<void>(() => undefined),
    );
    const started = Date.now();
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(pools.closePool).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives a fixed 500 and no detail when the database fails", async () => {
    const canary = "canary-row-text";
    sqlReads.answer = () => serverError("XX000", canary);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await get(authorized);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(warn.mock.calls)).toContain("unavailable:XX000");
  });

  it("gives a fixed 500 and names only the setting when config is missing", async () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await get(authorized);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("ALLOWED_GUILD_IDS");
  });

  it("builds a new Discord client and database handle on each run", async () => {
    // The first run's token is refused. The second must ask Discord afresh, and send.
    let tokenRefused = true;
    sqlReads.answer = reads({ candidate: true, forum: "active" });
    fetchMock.mockImplementation((input, init) => {
      const url = input as string;
      if (url.startsWith("https://discord.com")) {
        if (tokenRefused) {
          return Promise.resolve(new Response("{}", { status: 401 }));
        }
        return Promise.resolve(
          Response.json(
            init?.method === "POST"
              ? { id: FORUM }
              : { id: THREAD, type: 11, guild_id: GUILD, parent_id: FORUM },
          ),
        );
      }
      return Promise.reject(new Error("only Discord is reached over HTTP"));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const discordCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith("https://discord.com"),
      );

    await get(authorized);
    expect(discordCalls()).toHaveLength(1);

    tokenRefused = false;
    fetchMock.mockClear();
    await get(authorized);
    expect(
      discordCalls()
        .filter(([, init]) => init?.method === "POST")
        .map(([url]) => url),
    ).toEqual([expect.stringContaining(`/channels/${THREAD}/messages`)]);

    expect(clients.made).toHaveLength(2);
    expect(clients.made[1]).not.toBe(clients.made[0]);
    expect(databases.made).toHaveLength(2);
    expect(databases.made[1]).not.toBe(databases.made[0]);
    expect(pools.closePool).toHaveBeenCalledTimes(2);
    expect(pools.closePool.mock.calls.map(([database]) => database)).toEqual(
      pools.made,
    );
  });
});

describe("the Discord client the function builds", () => {
  const authorized = { authorization: `Bearer ${SECRET}` };

  /**
   * The database claims everything here, so the client's own check is all that stands
   * between the reminder and the send. Discord would accept the send.
   */
  function worldWhereForumIs(status: string | undefined) {
    sqlReads.answer = reads({ candidate: true, forum: status });
    fetchMock.mockImplementation((input, init) => {
      const url = input as string;
      if (url.startsWith("https://discord.com")) {
        return Promise.resolve(
          Response.json(
            init?.method === "POST"
              ? { id: FORUM }
              : { id: THREAD, type: 11, guild_id: GUILD, parent_id: FORUM },
          ),
        );
      }
      return Promise.reject(new Error("only Discord is reached over HTTP"));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  const discordPosts = () =>
    fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          (url as string).startsWith("https://discord.com") &&
          init?.method === "POST",
      )
      .map(([url]) => url as string);

  it("sends to a thread in an active forum", async () => {
    worldWhereForumIs("active");
    await get(authorized);
    expect(discordPosts()).toEqual([
      expect.stringContaining(`/channels/${THREAD}/messages`),
    ]);
  });

  it.each([
    ["has no row", undefined],
    ["is removed", "removed"],
    ["is unavailable", "unavailable"],
  ])("sends nothing when the forum %s", async (_label, status) => {
    worldWhereForumIs(status);
    await get(authorized);
    expect(discordPosts()).toEqual([]);
  });

  it("has the run's time limit for each operation", async () => {
    worldWhereForumIs("active");
    await get(authorized);
    expect(clients.options).toEqual([
      expect.objectContaining({
        budget: { operationMs: DISCORD_OPERATION_MS },
      }),
    ]);
  });
});

describe("deployment settings", () => {
  const vercel = vercelConfig(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const maxSeconds =
    vercel.functions["api/cron/reminders.ts"]?.maxDuration ?? 0;

  it("schedules a morning run and a recovery run of this endpoint", () => {
    expect(vercel.crons).toEqual([
      { path: "/api/cron/reminders", schedule: "0 15 * * *" },
      { path: "/api/cron/reminders", schedule: "0 17 * * *" },
    ]);
  });

  it("leaves more than the stale claim age between the two crons", () => {
    // A claim left by a failed morning run must be stale by the recovery run. Hobby
    // fires anywhere in the hour, so only one started by 16:00 is sure to be.
    expect(17 - 15).toBeGreaterThan(STALE_CLAIM_MS / 3_600_000);
  });

  it("stops new work with time left for one send and its marks", () => {
    expect(
      RUN_WORK_MS + DATABASE_CALL_MS + DISCORD_OPERATION_MS,
    ).toBeLessThanOrEqual(RUN_HARD_STOP_MS);
  });

  it("records the run inside the limit, after the last marks that may start", () => {
    expect(RUN_HARD_STOP_MS + 2 * DATABASE_CALL_MS).toBeLessThanOrEqual(
      maxSeconds * 1000,
    );
  });

  it("treats a run as dead only after the function must have ended", () => {
    expect(LOCK_STALE_SECONDS).toBeGreaterThan(maxSeconds);
  });

  it("lists this endpoint in the deploy check", () => {
    const workflow = readFileSync(
      join(ROOT, ".github", "workflows", "deploy-check.yml"),
      "utf8",
    );
    expect(workflow).toContain("./api/cron/reminders.func");
  });
});
