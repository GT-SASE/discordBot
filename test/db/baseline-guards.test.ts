/**
 * Guards in the baseline that no command reaches on its own: each closes a way the bot's
 * role could step around a limit, a check or the history of a row.
 */

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate.ts";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
  SERVER_SETUP,
  migrateAsOwner,
  type Connection,
} from "./harness.ts";

describe("the baseline's guards", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe("a deleted task", () => {
    async function deletedTask(): Promise<string> {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.tasks SET deleted_at = now() WHERE id = $1",
        [taskId],
      );
      return taskId;
    }

    it.each([
      ["undeleted", "NULL"],
      ["given another deletion time", "now() - interval '1 day'"],
    ])("cannot be %s by the bot", async (_label, value) => {
      const taskId = await deletedTask();
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BOT_APP,
            `UPDATE public.tasks SET deleted_at = ${value} WHERE id = $1`,
            [taskId],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("can be brought back by the tables' owner, by hand", async () => {
      const taskId = await deletedTask();
      await queryAs(
        db,
        MIGRATION_OWNER,
        "UPDATE public.tasks SET deleted_at = NULL WHERE id = $1",
        [taskId],
      );
      const { rows } = await db.query(
        "SELECT deleted_at FROM public.tasks WHERE id = $1",
        [taskId],
      );
      expect(rows).toEqual([{ deleted_at: null }]);
    });
  });

  describe("a closed event", () => {
    async function closedEvent(): Promise<string> {
      const guild = await insertGuild(db);
      const eventId = await insertEvent(db, guild);
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.events SET status = 'closed' WHERE id = $1",
        [eventId],
      );
      return eventId;
    }

    const status = async (eventId: string): Promise<unknown> => {
      const { rows } = await db.query<{ status: string }>(
        "SELECT status FROM public.events WHERE id = $1",
        [eventId],
      );
      return rows[0]?.status;
    };

    it("cannot be reopened by the bot", async () => {
      const eventId = await closedEvent();
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BOT_APP,
            "UPDATE public.events SET status = 'active' WHERE id = $1",
            [eventId],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await status(eventId)).toBe("closed");
    });

    it("can still have its other columns, and a repeated close, written by the bot", async () => {
      const eventId = await closedEvent();
      await queryAs(
        db,
        BOT_APP,
        "UPDATE public.events SET status = 'closed', name = 'Renamed' WHERE id = $1",
        [eventId],
      );
      expect(await status(eventId)).toBe("closed");
    });

    it("can be reopened by the tables' owner, by hand", async () => {
      const eventId = await closedEvent();
      await queryAs(
        db,
        MIGRATION_OWNER,
        "UPDATE public.events SET status = 'active' WHERE id = $1",
        [eventId],
      );
      expect(await status(eventId)).toBe("active");
    });
  });

  describe("a change of person", () => {
    it.each([
      "UPDATE public.tasks SET assignee_id = assignee_id",
      "UPDATE public.tasks SET description = description",
      "UPDATE public.tasks SET due_date = due_date",
    ])("cannot skip edit_task: %s", async (sql) => {
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("cannot be counted, or left uncounted, by the bot itself", async () => {
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BOT_APP,
            `INSERT INTO public.task_reassignments (guild_id, actor_id, task_id)
             VALUES ($1, $1, gen_random_uuid())`,
            [fakeId()],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("counts against the officer's limit only when the person changes", async () => {
      const guild = await insertGuild(db);
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      const actor = fakeId();
      const edit = async (assignee: string | null) => {
        const { rows } = await db.query<{
          assignee_id: string;
          updated_at: string;
        }>(
          "SELECT assignee_id, updated_at::text FROM public.tasks WHERE id = $1",
          [taskId],
        );
        const [task] = rows;
        await queryAs(
          db,
          BOT_APP,
          `SELECT public.edit_task($1, $2, $3, 'Book the room', '2030-01-10', $4, $5)`,
          [
            taskId,
            guild.guildId,
            task?.updated_at,
            assignee ?? task?.assignee_id,
            actor,
          ],
        );
      };
      const counted = async () => {
        const { rows } = await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM public.task_reassignments WHERE actor_id = $1",
          [actor],
        );
        return rows[0]?.count;
      };

      await edit(null);
      expect(await counted()).toBe(0);
      await edit(fakeId());
      expect(await counted()).toBe(1);
    });
  });

  it("refuses a step's hand-off on a closed event as parent_unavailable", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await queryAs(
      db,
      BOT_APP,
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guild.guildId, fakeId()],
    );
    await queryAs(
      db,
      BOT_APP,
      "UPDATE public.events SET status = 'closed' WHERE id = $1",
      [eventId],
    );
    expect(
      await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          "SELECT public.claim_step_handoff($1, $2, 'budget_sheet')",
          [eventId, guild.guildId],
        ),
      ),
    ).toBe("CF410");
  });

  it("sets up Food pickup and its reminders once the budget is approved", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const actor = fakeId();
    expect(
      await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          "SELECT public.assign_event_step($1, $2, 'food_pickup', $3, $3)",
          [eventId, guild.guildId, actor],
        ),
      ),
    ).toBe("CF428");
    expect(
      await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          "SELECT public.set_event_pickup_time($1, $2, '17:30', $3)",
          [eventId, guild.guildId, actor],
        ),
      ),
    ).toBe("CF428");
    await queryAs(
      db,
      BOT_APP,
      "SELECT public.complete_event_step($1, $2, 'budget_approved', $3)",
      [eventId, guild.guildId, actor],
    );
    await queryAs(
      db,
      BOT_APP,
      "SELECT public.assign_event_step($1, $2, 'food_pickup', $3, $3)",
      [eventId, guild.guildId, actor],
    );
    const done = await queryAs<{ done: boolean }>(
      db,
      BOT_APP,
      "SELECT public.set_event_pickup_time($1, $2, '17:30', $3) AS done",
      [eventId, guild.guildId, actor],
    );
    expect(done).toEqual([{ done: true }]);

    const claim = async (kind: string, date: string) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        BOT_APP,
        "SELECT public.claim_event_reminder($1, $2::public.event_reminder_kind, $3) AS token",
        [eventId, kind, date],
      );
      return rows[0]?.token ?? null;
    };
    // The fixture's event is on 2030-01-15.
    expect(await claim("pickup_two_days", "2030-01-13")).not.toBeNull();
    expect(await claim("pickup_day", "2030-01-15")).not.toBeNull();
    expect(await claim("pickup_day", "2030-01-14")).toBeNull();
  });

  it("claims a day's step reminder only for today or yesterday, never a day to come", async () => {
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const claim = async (daysAgo: number) => {
      const rows = await queryAs<{ token: string | null }>(
        db,
        BOT_APP,
        `SELECT public.claim_event_reminder(
           $1, 'daily_steps',
           ((now() AT TIME ZONE 'America/New_York')::date - $2::int)
         ) AS token`,
        [eventId, daysAgo],
      );
      return rows[0]?.token ?? null;
    };
    expect(await claim(3)).toBeNull();
    expect(await claim(2)).toBeNull();
    // The event is years away, so only the bound on today refuses these.
    expect(await claim(-1)).toBeNull();
    expect(await claim(-30)).toBeNull();
    expect(await claim(0)).not.toBeNull();
    expect(await claim(1)).not.toBeNull();
  });

  describe("history", () => {
    async function versionsOf(table: string, rowId: string): Promise<string[]> {
      const { rows } = await db.query<{ operation: string }>(
        `SELECT operation FROM history.row_versions
         WHERE source_table = $1 AND row_id = $2 ORDER BY id`,
        [table, rowId],
      );
      return rows.map((row) => row.operation);
    }

    it("keeps the old guild config, forum and setup draft rows on a change", async () => {
      const guild = await insertGuild(db);
      await queryAs(
        db,
        BOT_APP,
        `SELECT public.apply_config_change($1, 2, $2, false)`,
        [guild.guildId, fakeId()],
      );
      await queryAs(
        db,
        BOT_APP,
        `SELECT public.apply_config_change($1, 3, $2, NULL, ARRAY[]::text[], ARRAY[$3]::text[])`,
        [guild.guildId, fakeId(), guild.channelId],
      );
      const actor = fakeId();
      const draft = (fingerprint: string) =>
        queryAs(
          db,
          BOT_APP,
          `SELECT public.save_setup_draft($1, $2, $3, $3, $3, $3, $3, $3, $4)`,
          [guild.guildId, actor, fakeId(), fingerprint],
        );
      await draft("abcdefgh12345678");
      await draft("abcdefgh87654321");

      expect(await versionsOf("guild_config", guild.guildId)).toContain(
        "UPDATE",
      );
      expect(
        await versionsOf(
          "managed_channels",
          `${guild.guildId}:${guild.channelId}`,
        ),
      ).toContain("UPDATE");
      expect(
        (await versionsOf("setup_drafts", guild.guildId)).length,
      ).toBeGreaterThan(0);
    });

    it.each(["public.config_audit", "history.row_versions"])(
      "refuses TRUNCATE of %s, even by its owner",
      async (table) => {
        expect(
          await errorCodeOf(queryAs(db, MIGRATION_OWNER, `TRUNCATE ${table}`)),
        ).toBe("CF405");
      },
    );
  });

  it("gives the bot no temp tables, so it cannot keep data outside its grants", async () => {
    const { rows } = await db.query(
      `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS temp`,
      [BOT_APP],
    );
    expect(rows).toEqual([{ temp: false }]);
  });

  it.each([
    ["events_by_thread_idx", "(guild_id, thread_id)"],
    ["events_open_by_date_idx", "(status, event_date)"],
  ])("indexes events for the reads that need it: %s", async (name, columns) => {
    const { rows } = await db.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );
    expect(rows[0]?.definition).toContain(columns);
  });
});

describe("the large-object functions", () => {
  const LARGE_OBJECT_FUNCTIONS = [
    "pg_catalog.lo_creat(integer)",
    "pg_catalog.lo_create(oid)",
    "pg_catalog.lo_from_bytea(oid, bytea)",
    "pg_catalog.lo_put(oid, bigint, bytea)",
    "pg_catalog.lo_truncate(integer, integer)",
    "pg_catalog.lo_truncate64(integer, bigint)",
    "pg_catalog.lo_unlink(oid)",
    "pg_catalog.lowrite(integer, bytea)",
  ];

  /** Migrates a new database, and returns its notices and what bot_app can still run. */
  async function migrated(
    apply: (connection: Connection) => Promise<unknown>,
  ): Promise<{ notices: string[]; open: string[] }> {
    const db = new PGlite();
    try {
      await db.waitReady;
      await db.exec(SERVER_SETUP);
      const notices: string[] = [];
      await apply({
        query: db.query.bind(db),
        exec: (sql) =>
          db.exec(sql, {
            onNotice: (notice) => notices.push(notice.message ?? ""),
          }),
      });
      const { rows } = await db.query<{ signature: string }>(
        `SELECT f AS signature FROM unnest($1::text[]) AS f
         WHERE has_function_privilege('bot_app', f, 'EXECUTE')`,
        [LARGE_OBJECT_FUNCTIONS],
      );
      return { notices, open: rows.map((row) => row.signature) };
    } finally {
      await db.close();
    }
  }

  it("names each one bot_app can still run when the owner cannot revoke them", async () => {
    const { notices, open } = await migrated(migrateAsOwner);
    expect(open).toEqual(LARGE_OBJECT_FUNCTIONS);
    const limit = notices.filter((notice) =>
      notice.startsWith("platform limit: bot_app can still run"),
    );
    expect(limit).toHaveLength(1);
    for (const signature of LARGE_OBJECT_FUNCTIONS) {
      const name = signature.replace(/^pg_catalog\.|\(.*$/g, "");
      expect(limit[0]).toMatch(new RegExp(`\\b${name}\\(`));
    }
  });

  it("closes them all, with no notice, when a superuser migrates", async () => {
    const { notices, open } = await migrated((connection) =>
      migrate(connection),
    );
    expect(open).toEqual([]);
    expect(
      notices.filter((notice) => notice.startsWith("platform limit")),
    ).toEqual([]);
  });
});
