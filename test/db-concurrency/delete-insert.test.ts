import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const PARENT_UNAVAILABLE = "CF410";

/** A delete and an insert under it, in either order. Neither may leave an orphan. */
describe("a delete racing an insert", () => {
  const db = raceDatabase();
  const softDeleteSql = "SELECT public.soft_delete_event($1, $2) AS deleted";
  const insertTaskSql = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                         VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $3) RETURNING id`;

  it("an event's soft delete waits for a task being inserted, then deletes it too", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      [insertTaskSql, [eventId, guild.guildId, fakeId()]],
      [softDeleteSql, [eventId, guild.guildId]],
    );

    expect(second.rows).toEqual([{ deleted: 1 }]);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
      [eventId],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("a task insert waits for its event's soft delete, then is refused", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      [softDeleteSql, [eventId, guild.guildId]],
      [insertTaskSql, [eventId, guild.guildId, fakeId()]],
    );

    expect(second.code).toBe(PARENT_UNAVAILABLE);
  });

  it("an event insert waits for its channel's removal, then is refused", async () => {
    const guild = await insertGuild(db.connection);

    const second = await db.race(
      [
        "SELECT public.apply_config_change($1, 2, $2, NULL, NULL, ARRAY[$3]::text[])",
        [guild.guildId, fakeId(), guild.channelId],
      ],
      [
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
         VALUES ($1, $2, 'Social', '2030-02-01', $3) RETURNING id`,
        [guild.guildId, guild.channelId, fakeId()],
      ],
    );

    expect(second.code).toBe(PARENT_UNAVAILABLE);
  });
});
