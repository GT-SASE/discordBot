import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId, queryAs } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/** Two clicks on the same Done button, each handled by its own function instance. */
describe("a double click on Done", () => {
  const db = raceDatabase();

  it("marks a task done once, and the second click finds nothing to change", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const assignee = fakeId();
    const taskId = await insertTask(db.connection, guild, eventId, assignee);
    // The statement markOwnTaskDone sends.
    const markDone: [string, unknown[]] = [
      `UPDATE public.tasks SET status = 'done', completed_at = now()
       WHERE id = $1 AND guild_id = $2 AND assignee_id = $3
         AND status = 'open' AND deleted_at IS NULL
       RETURNING id`,
      [taskId, guild.guildId, assignee],
    ];

    const second = await db.race(markDone, markDone);

    expect(second.rows).toEqual([]);
    const { rows } = await db.observer.query(
      "SELECT status FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "done" }]);
  });

  it("marks a step done once, and the second click is told it was done already", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const complete: [string, unknown[]] = [
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3) AS done",
      [eventId, guild.guildId, fakeId()],
    ];

    const second = await db.race(complete, complete);

    expect(second.rows).toEqual([{ done: false }]);
  });

  it("hands a finished step off once, so the next role is pinged once", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    await queryAs(
      db.connection,
      "bot_app",
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guild.guildId, fakeId()],
    );
    const claim: [string, unknown[]] = [
      "SELECT public.claim_step_handoff($1, $2, 'budget_sheet') AS claimed",
      [eventId, guild.guildId],
    ];

    const second = await db.race(claim, claim);

    expect(second.rows).toEqual([{ claimed: false }]);
    const { rows } = await db.observer.query(
      `SELECT handoff_claimed_at IS NOT NULL AS claimed FROM public.event_steps
       WHERE event_id = $1 AND kind = 'budget_sheet'`,
      [eventId],
    );
    expect(rows).toEqual([{ claimed: true }]);
  });
});
