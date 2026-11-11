import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/**
 * The morning cron and the recovery cron, or a retried invocation, running at once. The
 * job lock keeps the second run out, and each reminder's claim stops a double send if
 * both get past it, as they can once a run's lock has gone stale.
 */
describe("two overlapping reminder runs", () => {
  const db = raceDatabase();
  const beginSql = "SELECT public.begin_job_run($1, 120) AS id";

  it("only one of two starts gets the run", async () => {
    const begin: [string, unknown[]] = [beginSql, [`race_${fakeId()}`]];
    const second = await db.race(begin, begin);
    expect(second.rows).toEqual([{ id: null }]);
  });

  it("a start waits for a finish in progress, then sees its success", async () => {
    const jobName = `race_${fakeId()}`;
    const { rows } = await db.observer.query<{ id: string }>(beginSql, [
      jobName,
    ]);

    const second = await db.race(
      ["SELECT public.finish_job_run($1, now(), '{}', NULL)", [rows[0]?.id]],
      [beginSql, [jobName]],
    );

    expect(second.rows).toEqual([{ id: null }]);
    const statuses = await db.observer.query(
      "SELECT status FROM public.job_runs WHERE job_name = $1",
      [jobName],
    );
    expect(statuses.rows).toEqual([{ status: "succeeded" }]);
  });

  it("only one of two claims on a task reminder gets a token", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);
    const claim: [string, unknown[]] = [
      "SELECT public.claim_reminder($1, 'one_day', '2030-01-10') AS token",
      [taskId],
    ];

    const second = await db.race(claim, claim);

    expect(second.rows).toEqual([{ token: null }]);
    const { rows } = await db.observer.query(
      "SELECT attempts, state FROM public.reminder_log WHERE task_id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ attempts: 1, state: "claimed" }]);
  });

  it("only one of two claims on an event's step reminder gets a token", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const claim: [string, unknown[]] = [
      "SELECT public.claim_event_reminder($1, 'daily_steps', '2030-01-15') AS token",
      [eventId],
    ];

    const second = await db.race(claim, claim);

    expect(second.rows).toEqual([{ token: null }]);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM public.event_reminder_log WHERE event_id = $1",
      [eventId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});
