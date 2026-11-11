import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const EVENT_TASK_LIMIT = "CF429";
const ACTOR_TASK_LIMIT = "CF430";
const FEATURE_NOT_SUPPORTED = "0A000";

/**
 * The task quotas, raced at their limit. They are there to stop an officer account, stolen
 * or careless, from flooding a server, and someone doing that on purpose would send writes
 * at the same moment to get past a count. Two writes for the last place must take turns,
 * and only one may get it.
 */
describe("two writes for the last place under a quota", () => {
  const db = raceDatabase();
  const insertBySql = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                       VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $4) RETURNING id`;
  const reassignSql = `INSERT INTO public.task_reassignments (guild_id, actor_id, task_id)
                       VALUES ($1, $2, $3)`;

  async function countOf(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await db.observer.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? -1;
  }

  /** New tasks and reassignments by one officer, the two things the daily quota counts. */
  async function officerActions(
    guildId: string,
    officer: string,
  ): Promise<number> {
    return countOf(
      `SELECT (SELECT count(*) FROM public.tasks WHERE guild_id = $1 AND created_by = $2)::int
            + (SELECT count(*) FROM public.task_reassignments WHERE guild_id = $1 AND actor_id = $2)::int AS n`,
      [guildId, officer],
    );
  }

  it("an officer's last new task of the day goes to one of two, in different events", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    // A second event, so the event's own lock does not make the two take turns and only
    // the officer's lock can.
    const otherEvent = await insertEvent(db.connection, guild);
    const officer = fakeId();
    for (let index = 0; index < 49; index += 1) {
      await db.observer.query(insertBySql, [
        eventId,
        guild.guildId,
        fakeId(),
        officer,
      ]);
    }

    const second = await db.race(
      [insertBySql, [eventId, guild.guildId, fakeId(), officer]],
      [insertBySql, [otherEvent, guild.guildId, fakeId(), officer]],
    );

    expect(second.code).toBe(ACTOR_TASK_LIMIT);
    expect(await officerActions(guild.guildId, officer)).toBe(50);
  });

  it("an event's last free place goes to one of two tasks", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    // Each by a different officer, so only the event's limit is reached.
    for (let index = 0; index < 99; index += 1) {
      await insertTask(db.connection, guild, eventId);
    }

    const second = await db.race(
      [insertBySql, [eventId, guild.guildId, fakeId(), fakeId()]],
      [insertBySql, [eventId, guild.guildId, fakeId(), fakeId()]],
    );

    expect(second.code).toBe(EVENT_TASK_LIMIT);
    expect(
      await countOf(
        "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
        [eventId],
      ),
    ).toBe(100);
  });

  it("an officer's last reassignment of the day goes to one of two", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const officer = fakeId();
    const created = await db.observer.query<{ id: string }>(insertBySql, [
      eventId,
      guild.guildId,
      fakeId(),
      officer,
    ]);
    for (let index = 0; index < 48; index += 1) {
      await db.observer.query(insertBySql, [
        eventId,
        guild.guildId,
        fakeId(),
        officer,
      ]);
    }
    const reassign: [string, unknown[]] = [
      reassignSql,
      [guild.guildId, officer, created.rows[0]?.id],
    ];

    const second = await db.race(reassign, reassign);

    expect(second.code).toBe(ACTOR_TASK_LIMIT);
    expect(await officerActions(guild.guildId, officer)).toBe(50);
  });

  it("a write at a higher isolation level is refused, as its count could miss the other's", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);

    await db.t1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(
      db.t1.query(insertBySql, [eventId, guild.guildId, fakeId(), fakeId()]),
    ).rejects.toMatchObject({ code: FEATURE_NOT_SUPPORTED });
    await db.t1.query("ROLLBACK");

    await db.t1.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await expect(
      db.t1.query(reassignSql, [guild.guildId, fakeId(), taskId]),
    ).rejects.toMatchObject({ code: FEATURE_NOT_SUPPORTED });
    await db.t1.query("ROLLBACK");
  });
});
