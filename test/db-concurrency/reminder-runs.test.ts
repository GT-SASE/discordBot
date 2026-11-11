import { describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase, settled, type Outcome } from "./race.ts";

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

  /**
   * claim_reminders takes its items in key order. That is what stops two runs that share
   * reminders from deadlocking: each holds the claims it has made until its call ends, and
   * if they took shared keys in different orders, each could end up holding one key the
   * other is waiting for.
   *
   * That only happens if both are partway through at once, so the test arranges it. T0
   * holds an uncommitted claim on X. T1's batch [A, X, B] claims A, then waits on T0 for X.
   * T2's batch [B, A] then starts. Sorted, it goes to A first and waits there on T1,
   * holding nothing. Taken as given, it would claim B and then wait on T1 for A; once T0
   * rolls back, T1 would claim X and wait on T2 for B, and Postgres would cancel one of the
   * two with 40P01.
   */
  it("two batch claims in opposite orders, caught partway, do not deadlock", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const created = [
      await insertTask(db.connection, guild, eventId),
      await insertTask(db.connection, guild, eventId),
      await insertTask(db.connection, guild, eventId),
    ];
    // Sorted the way Postgres compares uuids, so that A < X < B.
    const sorted = await db.observer.query<{ id: string }>(
      "SELECT task::text AS id FROM unnest($1::uuid[]) AS task ORDER BY task",
      [created],
    );
    const [a, x, b] = sorted.rows.map((row) => row.id);
    if (a === undefined || x === undefined || b === undefined) {
      throw new Error("expected three task ids");
    }
    const claimSql = `SELECT public.claim_reminders(
      $1::uuid[],
      array_fill('one_day'::public.reminder_kind, ARRAY[cardinality($1::uuid[])]),
      array_fill('2030-01-10'::date, ARRAY[cardinality($1::uuid[])]),
      array_fill(NULL::text, ARRAY[cardinality($1::uuid[])]),
      array_fill(NULL::timestamptz, ARRAY[cardinality($1::uuid[])])
    ) AS results`;

    const t0 = await db.connect();
    await t0.query("BEGIN");
    await t0.query(
      "SELECT public.claim_reminder($1, 'one_day', '2030-01-10') AS token",
      [x],
    );
    let first: Promise<Outcome> | undefined;
    let second: Promise<Outcome> | undefined;
    try {
      first = settled(db.t1.query(claimSql, [[a, x, b]]));
      await db.waitUntilBlocked(db.t1, t0);
      second = settled(db.t2.query(claimSql, [[b, a]]));
      await db.waitUntilBlocked(db.t2, db.t1);
    } finally {
      await t0.query("ROLLBACK");
    }
    const [one, two] = await Promise.all([first, second]);

    expect(one.code).toBeUndefined();
    expect(two.code).toBeUndefined();
    const tokens = one.rows?.[0]?.results;
    expect(tokens).toEqual([
      { claim_token: expect.any(String) as string, changed: false },
      { claim_token: expect.any(String) as string, changed: false },
      { claim_token: expect.any(String) as string, changed: false },
    ]);
    expect(two.rows).toEqual([
      {
        results: [
          { claim_token: null, changed: false },
          { claim_token: null, changed: false },
        ],
      },
    ]);
    const winners = (tokens as { claim_token: string }[]).map(
      (item) => item.claim_token,
    );
    const { rows } = await db.observer.query(
      `SELECT log.task_id::text AS task_id, log.claim_token::text AS claim_token,
              log.attempts, log.state
       FROM public.reminder_log AS log
       WHERE log.task_id = ANY($1::uuid[])
       ORDER BY log.task_id`,
      [created],
    );
    expect(rows).toEqual([
      { task_id: a, claim_token: winners[0], attempts: 1, state: "claimed" },
      { task_id: x, claim_token: winners[1], attempts: 1, state: "claimed" },
      { task_id: b, claim_token: winners[2], attempts: 1, state: "claimed" },
    ]);
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
