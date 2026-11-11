/**
 * The statements the database layer sends, for ordinary and hostile inputs. A write is
 * checked for its table, its filters and the values it writes, a function call for its
 * arguments, and a read for keeping every value out of the statement's text.
 */

import { describe, expect, it } from "vitest";
import {
  HOSTILE_STRINGS,
  mockPostgrest,
  testSnowflake,
  type MockResponse,
} from "../../test/support/mock-postgrest.ts";
import type { DateOnly } from "../lib/dates.ts";
import { countOpenTasksInChannel } from "./tasks.ts";
import {
  closeEvent,
  createEvent,
  getEvent,
  listEvents,
  attachEventPost,
  claimEventPostAttempt,
  createLinkedEvent,
  listEventsNamed,
  markEventThreadMissing,
  releaseEventPostAttempt,
  searchEvents,
  setEventOverviewMessage,
  setEventThread,
  softDeleteEvent,
} from "./events.ts";
import {
  applyConfigChange,
  applyRoleBindings,
  getGuildConfig,
  listRecentConfigChanges,
} from "./guild-config.ts";
import { claimInteraction } from "./interaction-claims.ts";
import {
  finishJobRun,
  getLatestJobRun,
  beginJobRun,
  type JobName,
} from "./job-runs.ts";
import {
  getEventThreadForum,
  getManagedChannel,
  listManagedChannels,
  listManagedChannelsByIds,
  listRecentEventsInChannel,
  markChannelUnavailable,
} from "./managed-channels.ts";
import {
  claimReminder,
  claimReminders,
  listReminderCandidates,
  listStaleClaims,
  markReminderSent,
  markRemindersSent,
  markReminderSkipped,
  recordReminderRefused,
  recordThreadRefusal,
  clearThreadRefusals,
  reclaimReminder,
} from "./reminders.ts";
import {
  findEventByThread,
  findEventEverOnThread,
  searchOpenEvents,
  searchOpenEventsByIdPrefix,
} from "./task-events.ts";
import {
  createTask,
  editTask,
  searchOpenTasksByIdPrefix,
  searchOwnOpenTasksByIdPrefix,
  softDeleteTaskIfUnchanged,
  getTask,
  listEventTasks,
  listOpenTasksForAssignee,
  markOwnTaskDone,
  markTaskDoneAsOfficer,
  searchLiveTasks,
  searchLiveTasksByIdPrefix,
  searchOpenTasks,
  searchOwnOpenTasks,
  softDeleteTask,
} from "./tasks.ts";

const GUILD = testSnowflake();
const ACTOR = testSnowflake();
const OTHER = testSnowflake();
const ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const DATE = "2030-01-10" as DateOnly;
const NOW = new Date("2030-01-01T12:00:00.000Z");
const VERSION = "2030-01-01T11:00:00.123456+00:00";

/**
 * An update as recorded: the columns it sets, and a statement that filters on each of
 * the old PostgREST-style filters given, `column=eq.value` or `column=is.null`, and
 * returns the row.
 */
function update(table: string, body: unknown, filters: string) {
  const conditions = filters.split("&").map((filter) => {
    const [column = "", test = ""] = filter.split("=");
    const operator = test.startsWith("is.null")
      ? " is null"
      : test.startsWith("neq.")
        ? " <> \\$"
        : " = \\$";
    return `(?=.*"${table}"\\."${column}"${operator})`;
  });
  return {
    method: "SQL",
    target: expect.stringMatching(
      new RegExp(
        `^update "${table}" set .* where ${conditions.join("")}.* returning `,
      ),
    ) as string,
    body,
  };
}

/** An edit of the text or the date alone, with the rest as some task might hold them. */
const editText = (
  db: Parameters<typeof editTask>[0],
  key: { guildId: string; taskId: string; expectedUpdatedAt: string },
  fields: { description?: string; dueDate?: DateOnly; assigneeId?: string },
) =>
  editTask(db, {
    ...key,
    description: "Book the room",
    dueDate: DATE,
    assigneeId: OTHER,
    actorId: ACTOR,
    ...fields,
  });

/** Rows as a statement built with Drizzle returns them: each one's values, in order. */
function asRows(response: MockResponse): MockResponse {
  return Array.isArray(response.body)
    ? {
        ...response,
        body: response.body.map((row: unknown) =>
          typeof row === "object" && row !== null ? Object.values(row) : row,
        ),
      }
    : response;
}

function taskRow() {
  return {
    id: ID,
    event_id: ID,
    guild_id: GUILD,
    assignee_id: ACTOR,
    description: "Book the room",
    due_date: DATE,
    status: "open",
    completed_at: null,
    created_by: ACTOR,
    deleted_at: null,
    updated_at: VERSION,
  };
}

function eventRow() {
  return {
    id: ID,
    guild_id: GUILD,
    channel_id: OTHER,
    name: "Social",
    event_date: DATE,
    thread_id: null,
    overview_message_id: null,
    status: "active",
    thread_status: "pending",
    created_by: ACTOR,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
  };
}

describe("exact requests", () => {
  const taskWrite = (body: unknown, filters: string) =>
    update("tasks", body, filters);
  const eventWrite = (body: unknown, filters: string) =>
    update("events", body, filters);
  const rpc = (name: string, body: unknown) => ({
    method: "SQL",
    target: expect.stringMatching(
      new RegExp(`^select public\\.${name}\\(`),
    ) as string,
    body,
  });

  const scopedTask = `id=eq.${ID}&guild_id=eq.${GUILD}`;
  const scopedEvent = `id=eq.${ID}&guild_id=eq.${GUILD}&deleted_at=is.null`;
  const reminderKey = {
    taskId: ID,
    kind: "one_day" as const,
    dueDate: DATE,
  };

  const cases: [
    string,
    (db: ReturnType<typeof mockPostgrest>["db"]) => Promise<{ ok: boolean }>,
    MockResponse,
    { method: string; target: string; body: unknown },
  ][] = [
    [
      "markOwnTaskDone",
      (db) =>
        markOwnTaskDone(db, {
          guildId: GUILD,
          taskId: ID,
          assigneeId: ACTOR,
          now: NOW,
        }),
      { body: [taskRow()] },
      taskWrite(
        { status: "done", completed_at: NOW.toISOString() },
        `${scopedTask}&assignee_id=eq.${ACTOR}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "markTaskDoneAsOfficer",
      (db) =>
        markTaskDoneAsOfficer(db, { guildId: GUILD, taskId: ID, now: NOW }),
      { body: [taskRow()] },
      taskWrite(
        { status: "done", completed_at: NOW.toISOString() },
        `${scopedTask}&status=eq.open&deleted_at=is.null`,
      ),
    ],
    [
      "editTask",
      (db) =>
        editTask(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          description: 'a,b).c"*%',
          dueDate: DATE,
          assigneeId: OTHER,
          actorId: ACTOR,
        }),
      { body: taskRow() },
      rpc("edit_task", {
        p_task_id: ID,
        p_guild_id: GUILD,
        p_expected_updated_at: VERSION,
        p_description: 'a,b).c"*%',
        p_due_date: DATE,
        p_assignee_id: OTHER,
        p_actor_id: ACTOR,
      }),
    ],
    [
      "softDeleteTaskIfUnchanged",
      (db) =>
        softDeleteTaskIfUnchanged(db, {
          guildId: GUILD,
          taskId: ID,
          expectedUpdatedAt: VERSION,
          now: NOW,
        }),
      { body: [taskRow()] },
      taskWrite(
        { deleted_at: NOW.toISOString() },
        `${scopedTask}&updated_at=eq.${VERSION}&deleted_at=is.null`,
      ),
    ],
    [
      "softDeleteTask",
      (db) => softDeleteTask(db, { guildId: GUILD, taskId: ID, now: NOW }),
      { body: [taskRow()] },
      taskWrite(
        { deleted_at: NOW.toISOString() },
        `${scopedTask}&deleted_at=is.null`,
      ),
    ],
    [
      "createTask",
      (db) =>
        createTask(db, {
          guildId: GUILD,
          eventId: ID,
          assigneeId: OTHER,
          actorId: ACTOR,
          description: "Book the room",
          dueDate: DATE,
        }),
      { status: 201, body: [taskRow()] },
      {
        method: "SQL",
        target: expect.stringMatching(
          /^insert into "tasks" .* returning /,
        ) as string,
        body: {
          event_id: ID,
          guild_id: GUILD,
          assignee_id: OTHER,
          description: "Book the room",
          due_date: DATE,
          created_by: ACTOR,
        },
      },
    ],
    [
      "createEvent",
      (db) =>
        createEvent(db, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
        }),
      { status: 201, body: [eventRow()] },
      {
        method: "SQL",
        target: expect.stringMatching(
          /^insert into "events" .* returning /,
        ) as string,
        body: {
          guild_id: GUILD,
          channel_id: OTHER,
          name: "Social",
          event_date: DATE,
          created_by: ACTOR,
        },
      },
    ],
    [
      "createLinkedEvent",
      (db) =>
        createLinkedEvent(db, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
          threadId: ACTOR,
        }),
      { status: 201, body: [eventRow()] },
      {
        method: "SQL",
        target: expect.stringMatching(
          /^insert into "events" .* returning /,
        ) as string,
        body: {
          guild_id: GUILD,
          channel_id: OTHER,
          name: "Social",
          event_date: DATE,
          created_by: ACTOR,
          thread_id: ACTOR,
          thread_status: "active",
        },
      },
    ],
    [
      "claimEventPostAttempt",
      (db) => claimEventPostAttempt(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("claim_event_post_attempt", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "releaseEventPostAttempt",
      (db) => releaseEventPostAttempt(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("release_event_post_attempt", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "attachEventPost",
      (db) =>
        attachEventPost(db, {
          guildId: GUILD,
          eventId: ID,
          threadId: OTHER,
          overviewMessageId: ACTOR,
        }),
      { body: [eventRow()] },
      eventWrite(
        {
          thread_id: OTHER,
          overview_message_id: ACTOR,
          thread_status: "active",
        },
        `${scopedEvent}&thread_status=eq.pending`,
      ),
    ],
    [
      "setEventThread",
      (db) =>
        setEventThread(db, { guildId: GUILD, eventId: ID, threadId: OTHER }),
      { body: [eventRow()] },
      eventWrite(
        { thread_id: OTHER, thread_status: "active" },
        `${scopedEvent}&thread_status=neq.active`,
      ),
    ],
    [
      "markEventThreadMissing",
      (db) => markEventThreadMissing(db, { guildId: GUILD, eventId: ID }),
      { body: [eventRow()] },
      eventWrite(
        { thread_status: "missing" },
        `${scopedEvent}&thread_status=eq.active`,
      ),
    ],
    [
      "setEventOverviewMessage",
      (db) =>
        setEventOverviewMessage(db, {
          guildId: GUILD,
          eventId: ID,
          messageId: OTHER,
        }),
      { body: [eventRow()] },
      eventWrite({ overview_message_id: OTHER }, scopedEvent),
    ],
    [
      "closeEvent",
      (db) => closeEvent(db, { guildId: GUILD, eventId: ID }),
      { body: [eventRow()] },
      eventWrite({ status: "closed" }, `${scopedEvent}&status=eq.active`),
    ],
    [
      "softDeleteEvent",
      (db) => softDeleteEvent(db, { guildId: GUILD, eventId: ID }),
      { body: 2 },
      rpc("soft_delete_event", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "applyRoleBindings",
      (db) =>
        applyRoleBindings(db, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 0,
          officerRoleId: OTHER,
          adminRoleId: OTHER,
          eboardRoleId: OTHER,
          eventsCommitteeRoleId: null,
          treasuryRoleId: OTHER,
          marketingRoleId: null,
        }),
      { body: 1 },
      rpc("apply_role_bindings", {
        p_guild_id: GUILD,
        p_expected_version: 0,
        p_actor_id: ACTOR,
        p_officer_role_id: OTHER,
        p_admin_role_id: OTHER,
        p_eboard_role_id: OTHER,
        p_events_committee_role_id: null,
        p_treasury_role_id: OTHER,
        p_marketing_role_id: null,
      }),
    ],
    [
      "applyConfigChange",
      (db) =>
        applyConfigChange(db, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 3,
          remindersEnabled: null,
          addChannelIds: [OTHER],
          removeChannelIds: [],
          timezone: null,
        }),
      { body: 4 },
      rpc("apply_config_change", {
        p_guild_id: GUILD,
        p_expected_version: 3,
        p_actor_id: ACTOR,
        p_reminders_enabled: null,
        p_add_channel_ids: [OTHER],
        p_remove_channel_ids: [],
        p_timezone: null,
      }),
    ],
    [
      "markChannelUnavailable",
      (db) => markChannelUnavailable(db, { guildId: GUILD, channelId: OTHER }),
      { body: true },
      rpc("mark_channel_unavailable", {
        p_guild_id: GUILD,
        p_channel_id: OTHER,
      }),
    ],
    [
      "claimInteraction",
      (db) => claimInteraction(db, { interactionId: OTHER }),
      { body: true },
      rpc("claim_interaction", { p_interaction_id: OTHER }),
    ],
    [
      "claimReminder",
      (db) => claimReminder(db, reminderKey),
      { body: TOKEN },
      rpc("claim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_assignee_id: null,
        p_updated_at: null,
      }),
    ],
    [
      "claimReminder, naming the task as read",
      (db) =>
        claimReminder(db, {
          ...reminderKey,
          asRead: { assigneeId: OTHER, updatedAt: VERSION },
        }),
      { body: TOKEN },
      rpc("claim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_assignee_id: OTHER,
        p_updated_at: VERSION,
      }),
    ],
    [
      "claimReminders",
      (db) =>
        claimReminders(db, [
          reminderKey,
          { ...reminderKey, asRead: { assigneeId: OTHER, updatedAt: VERSION } },
        ]),
      {
        body: [
          { claim_token: TOKEN, changed: false },
          { claim_token: null, changed: true },
        ],
      },
      rpc("claim_reminders", {
        p_task_ids: [ID, ID],
        p_kinds: ["one_day", "one_day"],
        p_due_dates: [DATE, DATE],
        p_assignee_ids: [null, OTHER],
        p_updated_ats: [null, VERSION],
      }),
    ],
    [
      "recordReminderRefused",
      (db) => recordReminderRefused(db, { ...reminderKey, claimToken: TOKEN }),
      { body: true },
      rpc("record_reminder_refused", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
    [
      "recordThreadRefusal",
      (db) => recordThreadRefusal(db, { guildId: GUILD, eventId: ID }),
      { body: 2 },
      rpc("record_thread_refusal", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "clearThreadRefusals",
      (db) => clearThreadRefusals(db, { guildId: GUILD, eventId: ID }),
      { body: true },
      rpc("clear_thread_refusals", { p_event_id: ID, p_guild_id: GUILD }),
    ],
    [
      "reclaimReminder",
      (db) => reclaimReminder(db, { ...reminderKey, claimToken: TOKEN }),
      { body: null },
      rpc("reclaim_reminder", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
        p_assignee_id: null,
        p_updated_at: null,
      }),
    ],
    [
      "markReminderSent",
      (db) =>
        markReminderSent(db, {
          ...reminderKey,
          claimToken: TOKEN,
          messageId: OTHER,
        }),
      { body: true },
      rpc("mark_reminder_sent", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
        p_message_id: OTHER,
      }),
    ],
    [
      "markRemindersSent",
      (db) =>
        markRemindersSent(db, {
          keys: [{ ...reminderKey, claimToken: TOKEN }],
          messageId: OTHER,
        }),
      { body: [true] },
      rpc("mark_reminders_sent", {
        p_task_ids: [ID],
        p_kinds: ["one_day"],
        p_due_dates: [DATE],
        p_claim_tokens: [TOKEN],
        p_message_id: OTHER,
      }),
    ],
    [
      "markReminderSkipped",
      (db) => markReminderSkipped(db, { ...reminderKey, claimToken: TOKEN }),
      { body: false },
      rpc("mark_reminder_skipped", {
        p_task_id: ID,
        p_kind: "one_day",
        p_due_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
  ];

  it.each(cases)("%s", async (_name, call, response, expected) => {
    const { db, requests } = mockPostgrest((request) =>
      request.target.startsWith("select public.") ? response : asRows(response),
    );
    const result = await call(db);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect({
      method: requests[0]?.method,
      target: requests[0]?.target,
      body: requests[0]?.body,
    }).toEqual(expected);
  });

  it("asks for the changed row back on every write, so the count can be checked", async () => {
    const { db, requests } = mockPostgrest(() => asRows({ body: [taskRow()] }));
    await markTaskDoneAsOfficer(db, { guildId: GUILD, taskId: ID, now: NOW });
    expect(requests[0]?.target).toMatch(/ returning "id", "event_id", /);
  });

  /** A planner row as the read returns it: the selected values, in order. */
  const candidate = (id: string, dueDate: string) => [
    id,
    ID,
    GUILD,
    ACTOR,
    "Book the room",
    dueDate,
    "open",
    VERSION,
    ID,
    "Social",
    null,
    "active",
    "pending",
    0,
    { guild_config: { timezone: "America/New_York" } },
    [],
  ];

  it("reads the planner in pages, continuing after the last row of each", async () => {
    let call = 0;
    const { db, requests } = mockPostgrest(() => {
      call += 1;
      return {
        body:
          call === 1
            ? Array.from({ length: 500 }, () => candidate(TOKEN, "2030-01-05"))
            : [candidate(ID, "2030-01-06")],
      };
    });
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.rows).toHaveLength(501);
    expect(result.ok && result.value.truncated).toBe(false);
    expect(requests).toHaveLength(2);
    // The second page starts after the first page's last due date and ID.
    expect(requests[1]?.body).toEqual(
      expect.arrayContaining(["2030-01-05", TOKEN]),
    );
    expect(requests[0]?.body).not.toContain(TOKEN);
  });

  it("reports the planner as truncated when it stops at the page limit", async () => {
    const { db, requests } = mockPostgrest(() => ({
      body: Array.from({ length: 500 }, () => candidate(TOKEN, "2030-01-05")),
    }));
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.truncated).toBe(true);
    expect(requests).toHaveLength(20);
  });

  it("stops and reports truncated if a full page ends with no readable position", async () => {
    const { db, requests } = mockPostgrest(() => ({
      body: Array.from({ length: 500 }, () =>
        candidate("not-a-uuid", "2030-01-05"),
      ),
    }));
    const result = await listReminderCandidates(db, { lastDueDate: DATE });
    expect(result.ok && result.value.truncated).toBe(true);
    expect(result.ok && result.value.excluded).toHaveLength(500);
    expect(requests).toHaveLength(1);
  });
});

describe("reads built with Drizzle", () => {
  const term = "x' OR 1=1 --";
  const reads: [
    string,
    (db: ReturnType<typeof mockPostgrest>["db"]) => Promise<unknown>,
  ][] = [
    ["getTask", (db) => getTask(db, { guildId: GUILD, taskId: ID })],
    ["getEvent", (db) => getEvent(db, { guildId: GUILD, eventId: ID })],
    [
      "searchOpenTasksByIdPrefix",
      (db) => searchOpenTasksByIdPrefix(db, { guildId: GUILD, prefix: "abc" }),
    ],
    [
      "searchLiveTasksByIdPrefix",
      (db) => searchLiveTasksByIdPrefix(db, { guildId: GUILD, prefix: "abc" }),
    ],
    [
      "searchOwnOpenTasksByIdPrefix",
      (db) =>
        searchOwnOpenTasksByIdPrefix(db, {
          guildId: GUILD,
          assigneeId: ACTOR,
          prefix: "abc",
        }),
    ],
    [
      "searchOpenEventsByIdPrefix",
      (db) => searchOpenEventsByIdPrefix(db, { guildId: GUILD, prefix: "abc" }),
    ],
    [
      "findEventByThread",
      (db) => findEventByThread(db, { guildId: GUILD, threadId: OTHER }),
    ],
    [
      "findEventEverOnThread",
      (db) => findEventEverOnThread(db, { guildId: GUILD, threadId: OTHER }),
    ],
    [
      "listOpenTasksForAssignee",
      (db) =>
        listOpenTasksForAssignee(db, { guildId: GUILD, assigneeId: ACTOR }),
    ],
    [
      "listEventTasks",
      (db) => listEventTasks(db, { guildId: GUILD, eventId: ID }),
    ],
    [
      "listEventsNamed",
      (db) =>
        listEventsNamed(db, {
          guildId: GUILD,
          channelId: OTHER,
          name: term,
          eventDate: DATE,
        }),
    ],
    ["listEvents", (db) => listEvents(db, { guildId: GUILD })],
    ["searchEvents", (db) => searchEvents(db, { guildId: GUILD, term })],
    ["getGuildConfig", (db) => getGuildConfig(db, { guildId: GUILD })],
    [
      "listRecentConfigChanges",
      (db) => listRecentConfigChanges(db, { guildId: GUILD }),
    ],
    [
      "getManagedChannel",
      (db) => getManagedChannel(db, { guildId: GUILD, channelId: OTHER }),
    ],
    [
      "getEventThreadForum",
      (db) => getEventThreadForum(db, { guildId: GUILD, threadId: OTHER }),
    ],
    [
      "listManagedChannels",
      (db) => listManagedChannels(db, { guildId: GUILD }),
    ],
    [
      "listManagedChannelsByIds",
      (db) =>
        listManagedChannelsByIds(db, {
          guildId: GUILD,
          channelIds: [OTHER, ACTOR],
        }),
    ],
    [
      "listRecentEventsInChannel",
      (db) =>
        listRecentEventsInChannel(db, {
          guildId: GUILD,
          channelId: OTHER,
          limit: 5,
        }),
    ],
    [
      "listReminderCandidates",
      (db) => listReminderCandidates(db, { lastDueDate: DATE }),
    ],
    ["listStaleClaims", (db) => listStaleClaims(db, { claimedBefore: NOW })],
    ["getLatestJobRun", (db) => getLatestJobRun(db, { jobName: "reminders" })],
  ];

  it.each(reads)(
    "%s sends one select, with every value as a parameter",
    async (_name, read) => {
      const { db, requests } = mockPostgrest();
      await read(db);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.target).toMatch(/^select /);
      expect(request?.target).not.toMatch(/select \*|\.\*/);
      for (const value of [GUILD, ACTOR, OTHER, ID, term, DATE]) {
        expect(request?.target).not.toContain(value);
      }
      expect(request?.body).not.toEqual([]);
    },
  );

  it("scopes a read by key to the guild and to live rows", async () => {
    const { db, requests } = mockPostgrest();
    await getTask(db, { guildId: GUILD, taskId: ID });
    expect(requests[0]?.target).toContain('"tasks"."guild_id" = $');
    expect(requests[0]?.target).toContain('"tasks"."deleted_at" is null');
    expect(requests[0]?.body).toEqual([ID, GUILD, 1]);
  });
});

describe("autocomplete search", () => {
  const searches: [
    string,
    (
      db: ReturnType<typeof mockPostgrest>["db"],
      term: string,
    ) => Promise<{ ok: boolean }>,
    string,
  ][] = [
    [
      "searchEvents",
      (db, term) => searchEvents(db, { guildId: GUILD, term }),
      "events",
    ],
    [
      "searchOpenEvents",
      (db, term) => searchOpenEvents(db, { guildId: GUILD, term }),
      "events",
    ],
    [
      "searchOpenTasks",
      (db, term) => searchOpenTasks(db, { guildId: GUILD, term }),
      "tasks",
    ],
    [
      "searchLiveTasks",
      (db, term) => searchLiveTasks(db, { guildId: GUILD, term }),
      "tasks",
    ],
    [
      "searchOwnOpenTasks",
      (db, term) =>
        searchOwnOpenTasks(db, { guildId: GUILD, assigneeId: ACTOR, term }),
      "tasks",
    ],
  ];

  describe.each(searches)("%s", (_name, search, table) => {
    it.each([
      [
        "a comma and a filter",
        "x,deleted_at.not.is.null",
        "%x,deleted\\_at.not.is.null%",
      ],
      ["a closing paren", "x)", "%x)%"],
      ["a dot", "a.b", "%a.b%"],
      ["a double quote", 'x","y', '%x","y%'],
      ["an asterisk", "x*", "%x*%"],
      ["a percent sign", "%", "%\\%%"],
      ["an underscore", "_", "%\\_%"],
      ["a backslash", "\\", "%\\\\%"],
      ["a quote and a comment", "x' OR 1=1 --", "%x' OR 1=1 --%"],
      ["a statement", "'; DELETE FROM tasks; --", "%'; DELETE FROM tasks; --%"],
    ])("sends %s only as a parameter", async (_case, term, pattern) => {
      const { db, requests } = mockPostgrest();
      await search(db, term);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.target).toMatch(new RegExp(`^select .* from "${table}"`));
      expect(request?.target).toMatch(/ ilike \$[0-9]+/);
      // One character can be part of a column name.
      expect(term.length === 1 || !request?.target.includes(term)).toBe(true);
      expect(request?.body).toContain(pattern);
      expect(request?.body).toContain(GUILD);
    });

    it.each(["x\u0000y", "\u0000", "x\ud800", "\udc00y"])(
      "refuses %j before any query",
      async (term) => {
        const { db, requests } = mockPostgrest();
        const result = await search(db, term);
        expect(result).toEqual({
          ok: false,
          error: { category: "invalid_input", code: null },
        });
        expect(requests).toEqual([]);
      },
    );

    it("caps a long term", async () => {
      const { db, requests } = mockPostgrest();
      await search(db, "a".repeat(6000));
      expect(requests[0]?.body).toContain(`%${"a".repeat(100)}%`);
    });
  });
});

describe("refusals before any query", () => {
  const db = () => mockPostgrest();

  /** Each call with one hostile value in the given position. */
  const idCalls: [
    string,
    (
      client: ReturnType<typeof mockPostgrest>["db"],
      hostile: string,
    ) => Promise<{ ok: boolean }>,
  ][] = [
    ["getTask guild", (c, h) => getTask(c, { guildId: h, taskId: ID })],
    ["getTask id", (c, h) => getTask(c, { guildId: GUILD, taskId: h })],
    [
      "getEventThreadForum guild",
      (c, h) => getEventThreadForum(c, { guildId: h, threadId: OTHER }),
    ],
    [
      "getEventThreadForum thread",
      (c, h) => getEventThreadForum(c, { guildId: GUILD, threadId: h }),
    ],
    ["getEvent guild", (c, h) => getEvent(c, { guildId: h, eventId: ID })],
    ["getEvent id", (c, h) => getEvent(c, { guildId: GUILD, eventId: h })],
    [
      "markOwnTaskDone assignee",
      (c, h) =>
        markOwnTaskDone(c, {
          guildId: GUILD,
          taskId: ID,
          assigneeId: h,
          now: NOW,
        }),
    ],
    [
      "markOwnTaskDone id",
      (c, h) =>
        markOwnTaskDone(c, {
          guildId: GUILD,
          taskId: h,
          assigneeId: ACTOR,
          now: NOW,
        }),
    ],
    [
      "softDeleteTask id",
      (c, h) => softDeleteTask(c, { guildId: GUILD, taskId: h, now: NOW }),
    ],
    [
      "softDeleteEvent guild",
      (c, h) => softDeleteEvent(c, { guildId: h, eventId: ID }),
    ],
    [
      "claimEventPostAttempt id",
      (c, h) => claimEventPostAttempt(c, { guildId: GUILD, eventId: h }),
    ],
    [
      "releaseEventPostAttempt id",
      (c, h) => releaseEventPostAttempt(c, { guildId: GUILD, eventId: h }),
    ],
    [
      "listEventsNamed channel",
      (c, h) =>
        listEventsNamed(c, {
          guildId: GUILD,
          channelId: h,
          name: "Social",
          eventDate: DATE,
        }),
    ],
    [
      "attachEventPost thread",
      (c, h) =>
        attachEventPost(c, {
          guildId: GUILD,
          eventId: ID,
          threadId: h,
          overviewMessageId: OTHER,
        }),
    ],
    [
      "attachEventPost message",
      (c, h) =>
        attachEventPost(c, {
          guildId: GUILD,
          eventId: ID,
          threadId: OTHER,
          overviewMessageId: h,
        }),
    ],
    [
      "createLinkedEvent thread",
      (c, h) =>
        createLinkedEvent(c, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: "Social",
          eventDate: DATE,
          threadId: h,
        }),
    ],
    [
      "setEventThread thread",
      (c, h) => setEventThread(c, { guildId: GUILD, eventId: ID, threadId: h }),
    ],
    ["getGuildConfig", (c, h) => getGuildConfig(c, { guildId: h })],
    [
      "applyRoleBindings actor",
      (c, h) =>
        applyRoleBindings(c, {
          guildId: GUILD,
          actorId: h,
          expectedVersion: 0,
          officerRoleId: OTHER,
          adminRoleId: OTHER,
          eboardRoleId: null,
          eventsCommitteeRoleId: null,
          treasuryRoleId: null,
          marketingRoleId: null,
        }),
    ],
    [
      "applyConfigChange guild",
      (c, h) =>
        applyConfigChange(c, {
          guildId: h,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: false,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: null,
        }),
    ],
    [
      "applyConfigChange channel list",
      (c, h) =>
        applyConfigChange(c, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: null,
          addChannelIds: [OTHER, h],
          removeChannelIds: [],
          timezone: null,
        }),
    ],
    [
      "listManagedChannelsByIds",
      (c, h) =>
        listManagedChannelsByIds(c, {
          guildId: GUILD,
          channelIds: [OTHER, h],
        }),
    ],
    [
      "listRecentEventsInChannel",
      (c, h) =>
        listRecentEventsInChannel(c, {
          guildId: GUILD,
          channelId: h,
          limit: 10,
        }),
    ],
    [
      "markChannelUnavailable",
      (c, h) => markChannelUnavailable(c, { guildId: GUILD, channelId: h }),
    ],
    ["claimInteraction", (c, h) => claimInteraction(c, { interactionId: h })],
    [
      "claimReminder task",
      (c, h) => claimReminder(c, { taskId: h, kind: "one_day", dueDate: DATE }),
    ],
    [
      "markReminderSent token",
      (c, h) =>
        markReminderSent(c, {
          taskId: ID,
          kind: "one_day",
          dueDate: DATE,
          claimToken: h,
          messageId: OTHER,
        }),
    ],
  ];

  describe.each(idCalls)("%s", (_name, call) => {
    it.each(HOSTILE_STRINGS)("refuses the ID %j", async (hostile) => {
      const { db: client, requests } = db();
      expect(await call(client, hostile)).toEqual({
        ok: false,
        error: { category: "invalid_input", code: null },
      });
      expect(requests).toEqual([]);
    });
  });

  const textCalls: [
    string,
    (
      client: ReturnType<typeof mockPostgrest>["db"],
      text: string,
    ) => Promise<{ ok: boolean }>,
  ][] = [
    [
      "createEvent name",
      (c, t) =>
        createEvent(c, {
          guildId: GUILD,
          channelId: OTHER,
          actorId: ACTOR,
          name: t,
          eventDate: DATE,
        }),
    ],
    [
      "createTask description",
      (c, t) =>
        createTask(c, {
          guildId: GUILD,
          eventId: ID,
          assigneeId: OTHER,
          actorId: ACTOR,
          description: t,
          dueDate: DATE,
        }),
    ],
    [
      "editTask",
      (c, t) =>
        editText(
          c,
          { guildId: GUILD, taskId: ID, expectedUpdatedAt: VERSION },
          { description: t },
        ),
    ],
    [
      "applyConfigChange timezone",
      (c, t) =>
        applyConfigChange(c, {
          guildId: GUILD,
          actorId: ACTOR,
          expectedVersion: 1,
          remindersEnabled: null,
          addChannelIds: [],
          removeChannelIds: [],
          timezone: t,
        }),
    ],
  ];

  describe.each(textCalls)("%s", (_name, call) => {
    it.each(["a\u0000b", "a\ud800b", "\udc00", "", "   "])(
      "refuses the text %j",
      async (text) => {
        const { db: client, requests } = db();
        expect((await call(client, text)).ok).toBe(false);
        expect(requests).toEqual([]);
      },
    );
  });

  it("refuses an overlong event name and task description", async () => {
    const { db: client, requests } = db();
    const name = await createEvent(client, {
      guildId: GUILD,
      channelId: OTHER,
      actorId: ACTOR,
      name: "x".repeat(101),
      eventDate: DATE,
    });
    const description = await editText(
      client,
      { guildId: GUILD, taskId: ID, expectedUpdatedAt: VERSION },
      { description: "x".repeat(1001) },
    );
    expect([name.ok, description.ok]).toEqual([false, false]);
    expect(requests).toEqual([]);
  });

  it.each(["infinity", "2030-02-30", "1999-12-31", "2030-01-10,x", ""])(
    "refuses the date %j",
    async (date) => {
      const { db: client, requests } = db();
      const results = await Promise.all([
        editText(
          client,
          { guildId: GUILD, taskId: ID, expectedUpdatedAt: VERSION },
          { dueDate: date as DateOnly },
        ),
        listReminderCandidates(client, { lastDueDate: date as DateOnly }),
        claimReminder(client, {
          taskId: ID,
          kind: "one_day",
          dueDate: date as DateOnly,
        }),
      ]);
      expect(results.map((result) => result.ok)).toEqual([false, false, false]);
      expect(requests).toEqual([]);
    },
  );

  it("refuses an invalid instant", async () => {
    const { db: client, requests } = db();
    const bad = new Date(Number.NaN);
    const results = await Promise.all([
      listStaleClaims(client, { claimedBefore: bad }),
      markTaskDoneAsOfficer(client, { guildId: GUILD, taskId: ID, now: bad }),
    ]);
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(requests).toEqual([]);
  });

  it("refuses a kind that is not a reminder kind", async () => {
    const { db: client, requests } = db();
    const result = await claimReminder(client, {
      taskId: ID,
      kind: "constructor" as "one_day",
      dueDate: DATE,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("refuses the guild ID as a role, since that is @everyone", async () => {
    const { db: client, requests } = db();
    const result = await applyRoleBindings(client, {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 0,
      officerRoleId: GUILD,
      adminRoleId: OTHER,
      eboardRoleId: null,
      eventsCommitteeRoleId: null,
      treasuryRoleId: null,
      marketingRoleId: null,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it.each([
    "eboardRoleId",
    "eventsCommitteeRoleId",
    "treasuryRoleId",
    "marketingRoleId",
  ] as const)("refuses the guild ID or a bad ID as %s", async (role) => {
    const { db: client, requests } = db();
    for (const value of [GUILD, "everyone", ""]) {
      const result = await applyRoleBindings(client, {
        guildId: GUILD,
        actorId: ACTOR,
        expectedVersion: 0,
        officerRoleId: OTHER,
        adminRoleId: OTHER,
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId: null,
        marketingRoleId: null,
        [role]: value,
      });
      expect(result.ok).toBe(false);
    }
    expect(requests).toEqual([]);
  });

  it("refuses a bad version", async () => {
    const { db: client, requests } = db();
    for (const expectedVersion of [-1, 1.5, Number.NaN, 2 ** 31]) {
      const result = await applyRoleBindings(client, {
        guildId: GUILD,
        actorId: ACTOR,
        expectedVersion,
        officerRoleId: OTHER,
        adminRoleId: OTHER,
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId: null,
        marketingRoleId: null,
      });
      expect(result.ok).toBe(false);
    }
    expect(requests).toEqual([]);
  });

  it("refuses more channels than one change may carry", async () => {
    const { db: client, requests } = db();
    const result = await applyConfigChange(client, {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 1,
      remindersEnabled: null,
      addChannelIds: Array.from({ length: 26 }, () => testSnowflake()),
      removeChannelIds: [],
      timezone: null,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("arguments are named, so extra properties go nowhere", () => {
  it("ignores a hostile p_actor_id on the input object", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: 2 }));
    const input = {
      guildId: GUILD,
      actorId: ACTOR,
      expectedVersion: 1,
      officerRoleId: OTHER,
      adminRoleId: OTHER,
      eboardRoleId: null,
      eventsCommitteeRoleId: null,
      treasuryRoleId: null,
      marketingRoleId: null,
      p_actor_id: "hostile",
      p_guild_id: "hostile",
    };
    await applyRoleBindings(db, input);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("hostile");
  });

  it("ignores extra columns on a new task", async () => {
    const { db, requests } = mockPostgrest(() => ({
      status: 201,
      body: [taskRow()],
    }));
    const input = {
      guildId: GUILD,
      eventId: ID,
      assigneeId: OTHER,
      actorId: ACTOR,
      description: "Book the room",
      dueDate: DATE,
      deleted_at: "hostile",
      status: "hostile",
    };
    await createTask(db, input);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("hostile");
  });
});

describe("row counts on writes", () => {
  const write = (db: ReturnType<typeof mockPostgrest>["db"]) =>
    markTaskDoneAsOfficer(db, { guildId: GUILD, taskId: ID, now: NOW });

  it("treats no changed row as not found", async () => {
    const { db } = mockPostgrest(() => ({ body: [] }));
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it("treats two changed rows as a failure", async () => {
    const { db } = mockPostgrest(() =>
      asRows({ body: [taskRow(), taskRow()] }),
    );
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "unexpected", code: null },
    });
  });

  it("treats a changed row it cannot read as a failure", async () => {
    const { db } = mockPostgrest(() =>
      asRows({ body: [{ ...taskRow(), due_date: "bad" }] }),
    );
    expect(await write(db)).toEqual({
      ok: false,
      error: { category: "bad_row", code: null },
    });
  });

  it("reports a null from soft_delete_event as not found", async () => {
    const { db } = mockPostgrest(() => ({ body: null }));
    expect(await softDeleteEvent(db, { guildId: GUILD, eventId: ID })).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it("reports an RPC value of the wrong type as a bad row", async () => {
    const { db } = mockPostgrest(() => ({ body: "yes" }));
    expect((await claimInteraction(db, { interactionId: OTHER })).ok).toBe(
      false,
    );
    expect(
      (await claimReminder(db, { taskId: ID, kind: "due_day", dueDate: DATE }))
        .ok,
    ).toBe(false);
  });
});

describe("countOpenTasksInChannel", () => {
  const CHANNEL = testSnowflake();
  const row = (index: number) => [
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ];

  it("asks only for open, live tasks of live events in this guild and channel", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [row(1), row(2)] }));

    expect(
      await countOpenTasksInChannel(db, { guildId: GUILD, channelId: CHANNEL }),
    ).toEqual({ ok: true, value: { count: 2, truncated: false } });
    const [request] = requests;
    expect(request?.target).toMatch(
      /^select "tasks"\."id" from "tasks" inner join "events"/,
    );
    for (const filter of [
      '"tasks"."guild_id" = $',
      '"tasks"."status" = $',
      '"tasks"."deleted_at" is null',
      '"events"."channel_id" = $',
      '"events"."deleted_at" is null',
    ]) {
      expect(request?.target).toContain(filter);
    }
    expect(request?.body).toEqual([GUILD, "open", CHANNEL, 101]);
  });

  it("says when it stopped counting", async () => {
    const { db } = mockPostgrest(() => ({
      body: Array.from({ length: 101 }, (_, index) => row(index)),
    }));

    expect(
      await countOpenTasksInChannel(db, { guildId: GUILD, channelId: CHANNEL }),
    ).toEqual({ ok: true, value: { count: 100, truncated: true } });
  });

  it.each(HOSTILE_STRINGS)(
    "refuses the ID %j with no query",
    async (hostile) => {
      const { db, requests } = mockPostgrest();

      expect(
        (
          await countOpenTasksInChannel(db, {
            guildId: GUILD,
            channelId: hostile,
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await countOpenTasksInChannel(db, {
            guildId: hostile,
            channelId: CHANNEL,
          })
        ).ok,
      ).toBe(false);
      expect(requests).toEqual([]);
    },
  );

  it("passes a failure on with no text", async () => {
    const { db } = mockPostgrest(() => ({
      status: 500,
      body: { code: "XX000", message: "canary" },
    }));

    const result = await countOpenTasksInChannel(db, {
      guildId: GUILD,
      channelId: CHANNEL,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

describe("database errors", () => {
  const canary = "canary-text";
  const failing = (code: string) =>
    mockPostgrest(() => ({
      status: 400,
      body: { code, message: canary, details: canary, hint: canary },
    }));

  it.each([
    ["CF409", "stale_version"],
    ["CF410", "parent_unavailable"],
    ["23505", "conflict"],
    ["23514", "constraint"],
    ["42501", "forbidden"],
  ])("reports %s as %s with no text", async (code, category) => {
    const { db } = failing(code);
    const result = await editText(
      db,
      {
        guildId: GUILD,
        taskId: ID,
        expectedUpdatedAt: VERSION,
      },
      {},
    );
    expect(result).toEqual({ ok: false, error: { category, code } });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe("job runs", () => {
  const run = {
    id: ID,
    job_name: "reminders",
    status: "running",
    started_at: "2030-01-01T12:00:00+00:00",
    heartbeat_at: "2030-01-01T12:00:00.5+00:00",
    finished_at: null,
    results: {},
    error: null,
  };

  it("starts a run only through the lock function", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: ID }));
    const result = await beginJobRun(db, {
      jobName: "reminders",
      staleAfterSeconds: 120,
    });
    expect(result).toEqual({ ok: true, value: ID });
    expect(requests[0]?.target).toMatch(/^select public\.begin_job_run\(/);
    expect(requests[0]?.body).toEqual({
      p_job_name: "reminders",
      p_stale_after_seconds: 120,
    });
  });

  it("refuses a job name that is not a known job", async () => {
    const { db, requests } = mockPostgrest();
    const result = await beginJobRun(db, {
      jobName: "x,y" as JobName,
      staleAfterSeconds: 120,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("stores a list of event IDs next to the counts", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, {
      id: ID,
      now: NOW,
      results: { threads_held: 1, held_event_ids: [TOKEN] },
      error: null,
    });
    expect(requests[0]?.body).toMatchObject({
      p_results: { threads_held: 1, held_event_ids: [TOKEN] },
    });
  });

  it("stores only a category and code as the error", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, {
      id: ID,
      now: NOW,
      results: { sent: 3 },
      error: { category: "constraint", code: "23514" },
    });
    expect(requests[0]?.target).toMatch(/^select public\.finish_job_run\(/);
    expect(requests[0]?.body).toEqual({
      p_id: ID,
      p_finished_at: NOW.toISOString(),
      p_results: { sent: 3 },
      p_error: "constraint:23514",
    });
  });

  it("sends no error for a run that succeeded", async () => {
    const { db, requests } = mockPostgrest(() => ({ body: [run] }));
    await finishJobRun(db, { id: ID, now: NOW, results: {}, error: null });
    expect(requests[0]?.body).toMatchObject({ p_error: null });
  });

  it("fails as not_found when the function finished nothing", async () => {
    const { db } = mockPostgrest(() => ({ body: [] }));
    expect(
      await finishJobRun(db, { id: ID, now: NOW, results: {}, error: null }),
    ).toMatchObject({ ok: false, error: { category: "not_found" } });
  });

  it.each([
    [{ "bad key": 1 }],
    [{ text: Number.NaN }],
    [{ text: "words" as unknown as number }],
    [{ text: ["words"] }],
    [{ held_event_ids: ["words"] }],
    [{ held_event_ids: Array.from({ length: 26 }, () => ID) }],
    [{ held_event_ids: "words" as unknown as string[] }],
  ])("refuses the results %j", async (results) => {
    const { db, requests } = mockPostgrest();
    const result = await finishJobRun(db, {
      id: ID,
      now: NOW,
      results,
      error: null,
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("editTask and the officer's limit", () => {
  const key = { guildId: GUILD, taskId: ID, expectedUpdatedAt: VERSION };

  it("reports the officer limit, which the database checks in the same call", async () => {
    const { db } = mockPostgrest(() => ({
      status: 400,
      body: { code: "CF430", message: "row text" },
    }));

    expect(await editText(db, key, {})).toEqual({
      ok: false,
      error: { category: "actor_task_limit", code: "CF430" },
    });
  });

  it("reports a task no longer at the version read as not found", async () => {
    const { db } = mockPostgrest(() => ({ body: null }));
    expect(await editText(db, key, {})).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it.each([
    ["a bad actor", { actorId: "x" }],
    ["a bad person", { assigneeId: "x" }],
  ])("sends nothing for %s", async (_name, fields) => {
    const { db, requests } = mockPostgrest();

    expect(
      (
        await editTask(db, {
          ...key,
          description: "Book it",
          dueDate: DATE,
          assigneeId: OTHER,
          actorId: ACTOR,
          ...fields,
        })
      ).ok,
    ).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("searching by the start of an ID", () => {
  it.each(["", "ABC", "abc123456", "g", "a,b", "a b", "a%"])(
    "sends nothing for %j",
    async (prefix) => {
      const { db, requests } = mockPostgrest();

      expect(
        (await searchOpenTasksByIdPrefix(db, { guildId: GUILD, prefix })).ok,
      ).toBe(false);
      expect(requests).toEqual([]);
    },
  );
});

describe("reminder batches", () => {
  const key = {
    taskId: "11111111-1111-4111-8111-111111111111",
    kind: "one_day" as const,
    dueDate: "2030-01-10" as DateOnly,
  };
  const TOKEN_ID = "22222222-2222-4222-8222-222222222222";

  it.each([
    ["too few answers", []],
    ["too many answers", [true, true]],
    ["an answer that is not a boolean", ["true"]],
    ["no list", { ok: true }],
  ])("reads %s as a bad row", async (_label, body) => {
    const { db } = mockPostgrest(() => ({ body }));

    const marked = await markRemindersSent(db, {
      keys: [{ ...key, claimToken: TOKEN_ID }],
      messageId: testSnowflake(),
    });

    expect(
      marked.ok ? marked.value[0] : { ok: false, error: marked.error },
    ).toMatchObject({ ok: false, error: { category: "bad_row" } });
  });

  it.each([
    ["a token that is not a UUID", { claim_token: "x", changed: false }],
    ["changed with a token", { claim_token: TOKEN_ID, changed: true }],
    ["no changed flag", { claim_token: TOKEN_ID }],
    ["no object", TOKEN_ID],
  ])("reads a claim with %s as a bad row", async (_label, answer) => {
    const { db } = mockPostgrest(() => ({ body: [answer] }));

    const claimed = await claimReminders(db, [key]);

    expect(claimed.ok && claimed.value[0]).toMatchObject({
      ok: false,
      error: { category: "bad_row" },
    });
  });

  it("fails every item when the call fails", async () => {
    const { db } = mockPostgrest(() => ({
      status: 500,
      body: { code: "XX000", message: "canary" },
    }));

    const claimed = await claimReminders(db, [key, key]);

    expect(claimed).toMatchObject({ ok: false });
  });

  it("makes no call when no item is valid, and refuses each", async () => {
    const { db, requests } = mockPostgrest();

    const marked = await markRemindersSent(db, {
      keys: [{ ...key, claimToken: TOKEN_ID }],
      messageId: "../1",
    });

    expect(marked).toEqual({
      ok: true,
      value: [{ ok: false, error: { category: "invalid_input", code: null } }],
    });
    expect(requests).toEqual([]);
  });

  it("refuses more than one batch can hold, with no call", async () => {
    const { db, requests } = mockPostgrest();

    const claimed = await claimReminders(
      db,
      Array.from({ length: 101 }, () => key),
    );

    expect(claimed.ok).toBe(false);
    expect(requests).toEqual([]);
  });
});
