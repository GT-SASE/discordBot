/**
 * claim_reminders and mark_reminders_sent, through the access layer: each item must get
 * the answer its single-item function would have given it, in the order it was asked.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimReminder,
  claimReminders,
  markRemindersSent,
} from "../../src/db/reminders.ts";
import { parseIsoDate, type DateOnly } from "../../src/lib/dates.ts";
import { openBackend, type Backend } from "./backend.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
} from "./fixtures.ts";
import { MIGRATION_OWNER, fakeId, present, queryAs } from "./harness.ts";

const DUE: DateOnly = present(parseIsoDate(FIXTURE_DUE_DATE));

let backend: Backend;

beforeAll(async () => {
  backend = await openBackend();
});

afterAll(() => backend.close());

async function openTasks(count: number) {
  const guild = await insertGuild(backend.connection);
  const eventId = await insertEvent(backend.connection, guild);
  const taskIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    taskIds.push(await insertTask(backend.connection, guild, eventId));
  }
  return { guild, eventId, taskIds };
}

const key = (taskId: string) => ({
  taskId,
  kind: "due_day" as const,
  dueDate: DUE,
});

async function logStates(taskIds: readonly string[]) {
  const rows = await queryAs<{ task_id: string; state: string }>(
    backend.connection,
    MIGRATION_OWNER,
    `SELECT task_id, state::text AS state FROM public.reminder_log
     WHERE task_id = ANY($1::uuid[]) ORDER BY task_id`,
    [taskIds],
  );
  return Object.fromEntries(rows.map((row) => [row.task_id, row.state]));
}

describe("claim_reminders", () => {
  it("answers each item as claim_reminder would, in the order given", async () => {
    const { taskIds } = await openTasks(3);
    const [first, held, changed] = taskIds as [string, string, string];
    expect((await claimReminder(backend.db, key(held))).ok).toBe(true);

    const answers = await claimReminders(backend.db, [
      key(first),
      key(held),
      {
        ...key(changed),
        asRead: { assigneeId: fakeId(), updatedAt: new Date().toISOString() },
      },
    ]);

    expect(answers.ok).toBe(true);
    const [claimed, taken, outdated] = answers.ok ? answers.value : [];
    expect(claimed).toMatchObject({ ok: true });
    expect(claimed?.ok === true && claimed.value).toMatch(/^[0-9a-f-]{36}$/);
    // Someone else's claim, as claim_reminder answers it: no token.
    expect(taken).toEqual({ ok: true, value: null });
    // The item that changed since it was read fails alone.
    expect(outdated).toEqual({
      ok: false,
      error: { category: "task_changed", code: "CF412" },
    });
    expect(await logStates(taskIds)).toEqual({
      [first]: "claimed",
      [held]: "claimed",
    });
  });

  it("claims nothing for a forum no longer managed", async () => {
    const { guild, taskIds } = await openTasks(2);
    await queryAs(
      backend.connection,
      MIGRATION_OWNER,
      `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
      [guild.guildId],
    );

    const answers = await claimReminders(
      backend.db,
      taskIds.map((id) => key(id)),
    );

    expect(answers).toEqual({
      ok: true,
      value: [
        { ok: true, value: null },
        { ok: true, value: null },
      ],
    });
    expect(await logStates(taskIds)).toEqual({});
  });

  it("answers a repeated item as a second call would", async () => {
    const { taskIds } = await openTasks(1);
    const [only] = taskIds as [string];

    const answers = await claimReminders(backend.db, [key(only), key(only)]);

    expect(answers.ok && answers.value.map((answer) => answer.ok)).toEqual([
      true,
      true,
    ]);
    expect(answers.ok && answers.value[1]).toEqual({ ok: true, value: null });
  });

  it("refuses an invalid item alone, before the call", async () => {
    const { taskIds } = await openTasks(1);
    const [only] = taskIds as [string];

    const answers = await claimReminders(backend.db, [
      key("not-a-uuid"),
      key(only),
    ]);

    expect(answers.ok && answers.value[0]).toEqual({
      ok: false,
      error: { category: "invalid_input", code: null },
    });
    expect(answers.ok && answers.value[1]?.ok).toBe(true);
  });

  it.each([
    ["lists of different lengths", 2, 1],
    ["more than 100 items", 101, 101],
  ])("refuses %s and claims nothing", async (_label, tasks, kinds) => {
    const { taskIds } = await openTasks(1);
    const ids = Array.from({ length: tasks }, () => taskIds[0]);
    const error = await queryAs(
      backend.connection,
      "service_role",
      `SELECT public.claim_reminders($1::uuid[],
         (SELECT array_agg('due_day'::public.reminder_kind) FROM generate_series(1, $2)),
         (SELECT array_agg($3::date) FROM generate_series(1, $2)),
         (SELECT array_agg(NULL::text) FROM generate_series(1, $2)),
         (SELECT array_agg(NULL::timestamptz) FROM generate_series(1, $2)))`,
      [ids, kinds, FIXTURE_DUE_DATE],
    ).then(
      () => undefined,
      (failure: unknown) => (failure as { code?: string }).code,
    );

    expect(error).toBe("22023");
    expect(await logStates(taskIds)).toEqual({});
  });

  it("answers an empty list with an empty array", async () => {
    const rows = await queryAs<{ value: unknown }>(
      backend.connection,
      "service_role",
      `SELECT public.claim_reminders('{}', '{}', '{}', '{}', '{}') AS value`,
    );
    expect(rows[0]?.value).toEqual([]);
  });
});

describe("mark_reminders_sent", () => {
  it("answers each item as mark_reminder_sent would, in the order given", async () => {
    const { taskIds } = await openTasks(3);
    const claimed = await claimReminders(
      backend.db,
      taskIds.map((id) => key(id)),
    );
    const tokens = (claimed.ok ? claimed.value : []).map((answer) =>
      answer.ok && answer.value !== null ? answer.value : "",
    );
    const messageId = fakeId();
    const [first, second, third] = taskIds as [string, string, string];

    const marked = await markRemindersSent(backend.db, {
      keys: [
        { ...key(third), claimToken: tokens[2] ?? "" },
        // Not this claim's token.
        { ...key(second), claimToken: tokens[0] ?? "" },
        { ...key(first), claimToken: tokens[0] ?? "" },
      ],
      messageId,
    });

    expect(marked).toEqual({
      ok: true,
      value: [
        { ok: true, value: true },
        { ok: true, value: false },
        { ok: true, value: true },
      ],
    });
    expect(await logStates(taskIds)).toEqual({
      [first]: "sent",
      [second]: "claimed",
      [third]: "sent",
    });
    const rows = await queryAs<{ message_id: string | null }>(
      backend.connection,
      MIGRATION_OWNER,
      `SELECT message_id FROM public.reminder_log WHERE task_id = $1`,
      [first],
    );
    expect(rows[0]?.message_id).toBe(messageId);
  });

  it("marks nothing twice", async () => {
    const { taskIds } = await openTasks(1);
    const [only] = taskIds as [string];
    const claimed = await claimReminder(backend.db, key(only));
    const claimToken = claimed.ok ? (claimed.value ?? "") : "";
    const keys = [{ ...key(only), claimToken }];

    await markRemindersSent(backend.db, { keys, messageId: fakeId() });
    const again = await markRemindersSent(backend.db, {
      keys,
      messageId: fakeId(),
    });

    expect(again).toEqual({ ok: true, value: [{ ok: true, value: false }] });
  });
});

it("runs both as their owner, with an empty search path", async () => {
  const rows = await queryAs<{
    proname: string;
    prosecdef: boolean;
    proconfig: string[];
  }>(
    backend.connection,
    MIGRATION_OWNER,
    `SELECT proname, prosecdef, proconfig FROM pg_proc
     WHERE proname IN ('claim_reminders', 'mark_reminders_sent') ORDER BY proname`,
  );
  expect(rows).toEqual(
    ["claim_reminders", "mark_reminders_sent"].map((proname) => ({
      proname,
      prosecdef: true,
      proconfig: ['search_path=""'],
    })),
  );
});
