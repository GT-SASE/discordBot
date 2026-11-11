import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const PARENT_UNAVAILABLE = "CF410";

/** A task being changed while something else changes it, or closes its event. */
describe("a task change racing another change", () => {
  const db = raceDatabase();

  it("a Done click waiting on a reassign finds the task no longer the clicker's", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const assignee = fakeId();
    const taskId = await insertTask(db.connection, guild, eventId, assignee);
    const newAssignee = fakeId();

    const second = await db.race(
      [
        "UPDATE public.tasks SET assignee_id = $1 WHERE id = $2",
        [newAssignee, taskId],
      ],
      // The statement markOwnTaskDone sends.
      [
        `UPDATE public.tasks SET status = 'done', completed_at = now()
         WHERE id = $1 AND guild_id = $2 AND assignee_id = $3
           AND status = 'open' AND deleted_at IS NULL
         RETURNING id`,
        [taskId, guild.guildId, assignee],
      ],
    );

    expect(second.rows).toEqual([]);
    const { rows } = await db.observer.query(
      "SELECT status, assignee_id FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "open", assignee_id: newAssignee }]);
  });

  describe("against the event being closed", () => {
    const changeSql =
      "UPDATE public.tasks SET description = 'New' WHERE id = $1";
    const closeSql =
      "UPDATE public.events SET status = 'closed' WHERE id = $1 RETURNING id";

    it("a change waiting on the close is refused", async () => {
      const guild = await insertGuild(db.connection);
      const eventId = await insertEvent(db.connection, guild);
      const taskId = await insertTask(db.connection, guild, eventId);

      const second = await db.race(
        [closeSql, [eventId]],
        [changeSql, [taskId]],
      );

      expect(second.code).toBe(PARENT_UNAVAILABLE);
      const { rows } = await db.observer.query(
        "SELECT description FROM public.tasks WHERE id = $1",
        [taskId],
      );
      expect(rows).toEqual([{ description: "Book the room" }]);
    });

    it("a close waits for a change in progress, then closes", async () => {
      const guild = await insertGuild(db.connection);
      const eventId = await insertEvent(db.connection, guild);
      const taskId = await insertTask(db.connection, guild, eventId);

      const second = await db.race(
        [changeSql, [taskId]],
        [closeSql, [eventId]],
      );

      expect(second.rows).toEqual([{ id: eventId }]);
    });
  });
});
