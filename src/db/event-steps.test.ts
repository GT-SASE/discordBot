/**
 * The exact requests the event workflow functions send, what they refuse before any
 * query, and how they read the answers. test/db covers what the database does with them.
 */

import { describe, expect, it } from "vitest";
import {
  HOSTILE_STRINGS,
  mockDb,
  testSnowflake,
  type MockResponse,
} from "../../test/support/mock-db.ts";
import type { DateOnly } from "../lib/dates.ts";
import {
  assignEventStep,
  claimEventReminder,
  claimStepHandoff,
  completeEventStep,
  getEventWorkflow,
  listEventReminderCandidates,
  listEventWorkflows,
  listOpenStepsForUser,
  listStaleEventReminderClaims,
  markEventReminderSent,
  markEventReminderSkipped,
  markStepHandoffSent,
  reclaimEventReminder,
  setEventPickupTime,
  unassignEventStep,
} from "./event-steps.ts";
import {
  draftRoles,
  getSetupDraft,
  saveSetupDraft,
  setupDraftFingerprint,
  type SetupRoles,
} from "./guild-config.ts";

const GUILD = testSnowflake();
const ACTOR = testSnowflake();
const USER = testSnowflake();
const ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "11111111-2222-4333-8444-666666666666";
const TOKEN = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const DATE = "2030-01-10" as DateOnly;
const NOW = new Date("2030-01-01T12:00:00.000Z");
const CREATED = "2030-01-01T11:00:00.123456+00:00";

const ROLES: SetupRoles = {
  officerRoleId: testSnowflake(),
  adminRoleId: testSnowflake(),
  eboardRoleId: testSnowflake(),
  eventsCommitteeRoleId: testSnowflake(),
  treasuryRoleId: testSnowflake(),
  marketingRoleId: testSnowflake(),
};

function step(kind: string, status = "open") {
  return {
    event_id: ID,
    kind,
    status,
    completed_at: status === "done" ? CREATED : null,
    completed_by: status === "done" ? ACTOR : null,
    handoff_claimed_at: null,
    handoff_sent_at: null,
  };
}

function assignee(id: string, kind: string, createdAt: string) {
  return {
    id,
    event_id: ID,
    kind,
    user_id: USER,
    assigned_by: ACTOR,
    created_at: createdAt,
  };
}

function workflowRow() {
  return {
    id: ID,
    pickup_time: "17:30:00",
    // Out of order on purpose: the reader sorts them.
    event_steps: [
      step("food_pickup"),
      step("budget_approved", "done"),
      step("engage_post"),
      step("budget_sheet", "done"),
    ],
    event_step_assignees: [
      assignee(OTHER_ID, "engage_post", "2030-01-02T00:00:00+00:00"),
      assignee(ID, "budget_sheet", "2030-01-01T00:00:00+00:00"),
    ],
  };
}

const rpc = (name: string, values: unknown) => ({
  target: expect.stringMatching(
    new RegExp(`^select public\\.${name}\\(`),
  ) as string,
  values,
});
/**
 * Rows as a read built with Drizzle returns them: each one's values in the order
 * selected, with the fields of a joined event in its place.
 */
function values(...rows: Record<string, unknown>[]): unknown[][] {
  return rows.map((row) =>
    Object.entries(row).flatMap(([key, value]): unknown[] =>
      key === "events" ? Object.values(value as object) : [value],
    ),
  );
}

const assignment = {
  guildId: GUILD,
  eventId: ID,
  kind: "budget_sheet" as const,
  userId: USER,
  actorId: ACTOR,
};
const reminderKey = {
  eventId: ID,
  kind: "daily_steps" as const,
  reminderDate: DATE,
};

describe("exact requests", () => {
  const cases: [
    string,
    (db: ReturnType<typeof mockDb>["db"]) => Promise<{ ok: boolean }>,
    MockResponse,
    { target: string; values: unknown },
  ][] = [
    [
      "assignEventStep",
      (db) => assignEventStep(db, assignment),
      { value: true },
      rpc("assign_event_step", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_kind: "budget_sheet",
        p_user_id: USER,
        p_actor_id: ACTOR,
      }),
    ],
    [
      "unassignEventStep",
      (db) => unassignEventStep(db, { ...assignment, kind: "food_pickup" }),
      { value: false },
      rpc("unassign_event_step", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_kind: "food_pickup",
        p_user_id: USER,
        p_actor_id: ACTOR,
      }),
    ],
    [
      "completeEventStep",
      (db) =>
        completeEventStep(db, {
          guildId: GUILD,
          eventId: ID,
          kind: "budget_approved",
          actorId: ACTOR,
        }),
      { value: true },
      rpc("complete_event_step", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_kind: "budget_approved",
        p_actor_id: ACTOR,
      }),
    ],
    [
      "claimStepHandoff",
      (db) =>
        claimStepHandoff(db, {
          guildId: GUILD,
          eventId: ID,
          kind: "engage_post",
        }),
      { value: true },
      rpc("claim_step_handoff", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_kind: "engage_post",
      }),
    ],
    [
      "markStepHandoffSent",
      (db) =>
        markStepHandoffSent(db, {
          guildId: GUILD,
          eventId: ID,
          kind: "engage_post",
        }),
      { value: true },
      rpc("mark_step_handoff_sent", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_kind: "engage_post",
      }),
    ],
    [
      "setEventPickupTime",
      (db) =>
        setEventPickupTime(db, {
          guildId: GUILD,
          eventId: ID,
          pickupTime: "17:30",
          actorId: ACTOR,
        }),
      { value: false },
      rpc("set_event_pickup_time", {
        p_event_id: ID,
        p_guild_id: GUILD,
        p_pickup_time: "17:30",
        p_actor_id: ACTOR,
      }),
    ],
    [
      "claimEventReminder",
      (db) => claimEventReminder(db, reminderKey),
      { value: TOKEN },
      rpc("claim_event_reminder", {
        p_event_id: ID,
        p_kind: "daily_steps",
        p_reminder_date: DATE,
      }),
    ],
    [
      "reclaimEventReminder",
      (db) => reclaimEventReminder(db, { ...reminderKey, claimToken: TOKEN }),
      { value: null },
      rpc("reclaim_event_reminder", {
        p_event_id: ID,
        p_kind: "daily_steps",
        p_reminder_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
    [
      "markEventReminderSent",
      (db) =>
        markEventReminderSent(db, {
          ...reminderKey,
          claimToken: TOKEN,
          messageId: USER,
        }),
      { value: true },
      rpc("mark_event_reminder_sent", {
        p_event_id: ID,
        p_kind: "daily_steps",
        p_reminder_date: DATE,
        p_claim_token: TOKEN,
        p_message_id: USER,
      }),
    ],
    [
      "markEventReminderSkipped",
      (db) =>
        markEventReminderSkipped(db, { ...reminderKey, claimToken: TOKEN }),
      { value: true },
      rpc("mark_event_reminder_skipped", {
        p_event_id: ID,
        p_kind: "daily_steps",
        p_reminder_date: DATE,
        p_claim_token: TOKEN,
      }),
    ],
    [
      "saveSetupDraft",
      (db) =>
        saveSetupDraft(db, { guildId: GUILD, actorId: ACTOR, roles: ROLES }),
      { value: true },
      rpc("save_setup_draft", {
        p_guild_id: GUILD,
        p_actor_id: ACTOR,
        p_officer_role_id: ROLES.officerRoleId,
        p_admin_role_id: ROLES.adminRoleId,
        p_eboard_role_id: ROLES.eboardRoleId,
        p_events_committee_role_id: ROLES.eventsCommitteeRoleId,
        p_treasury_role_id: ROLES.treasuryRoleId,
        p_marketing_role_id: ROLES.marketingRoleId,
        p_fingerprint: setupDraftFingerprint(ROLES),
      }),
    ],
  ];

  it.each(cases)("%s", async (_name, call, response, expected) => {
    const { db, requests } = mockDb(() => response);
    const result = await call(db);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect({
      target: requests[0]?.target,
      values: requests[0]?.values,
    }).toEqual(expected);
  });
});

describe("reads built with Drizzle", () => {
  it.each([
    [
      "listEventWorkflows",
      (db: ReturnType<typeof mockDb>["db"]) =>
        listEventWorkflows(db, { guildId: GUILD, eventIds: [ID, OTHER_ID] }),
    ],
    [
      "listOpenStepsForUser",
      (db: ReturnType<typeof mockDb>["db"]) =>
        listOpenStepsForUser(db, { guildId: GUILD, userId: USER, today: DATE }),
    ],
    [
      "listEventReminderCandidates",
      (db: ReturnType<typeof mockDb>["db"]) =>
        listEventReminderCandidates(db, { fromDate: DATE }),
    ],
    [
      "listStaleEventReminderClaims",
      (db: ReturnType<typeof mockDb>["db"]) =>
        listStaleEventReminderClaims(db, { claimedBefore: NOW }),
    ],
    [
      "getSetupDraft",
      (db: ReturnType<typeof mockDb>["db"]) =>
        getSetupDraft(db, {
          guildId: GUILD,
          actorId: ACTOR,
          fingerprint: setupDraftFingerprint(ROLES),
          now: NOW,
        }),
    ],
  ])(
    "%s sends one select, with every value as a parameter",
    async (_name, call) => {
      const { db, requests } = mockDb();
      await call(db);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request?.target).toMatch(/^select /);
      expect(request?.target).not.toMatch(/select \*|\.\*/);
      for (const value of [GUILD, ACTOR, USER, ID, OTHER_ID, DATE]) {
        expect(request?.target).not.toContain(value);
      }
    },
  );

  it("reads only live assignments, of live events in this guild", async () => {
    const { db, requests } = mockDb();
    await listEventWorkflows(db, { guildId: GUILD, eventIds: [ID] });
    const sql = requests[0]?.target ?? "";
    expect(sql).toContain('"event_step_assignees"."removed_at" IS NULL');
    expect(sql).toContain('"events"."deleted_at" is null');
    expect(requests[0]?.values).toEqual([GUILD, ID, 100]);
  });
});

describe("refusals before any query", () => {
  const calls: [
    string,
    (
      db: ReturnType<typeof mockDb>["db"],
      hostile: string,
    ) => Promise<{ ok: boolean }>,
  ][] = [
    [
      "listEventWorkflows guild",
      (db, h) => listEventWorkflows(db, { guildId: h, eventIds: [ID] }),
    ],
    [
      "listEventWorkflows id",
      (db, h) => listEventWorkflows(db, { guildId: GUILD, eventIds: [ID, h] }),
    ],
    [
      "getEventWorkflow",
      (db, h) => getEventWorkflow(db, { guildId: GUILD, eventId: h }),
    ],
    [
      "assignEventStep user",
      (db, h) => assignEventStep(db, { ...assignment, userId: h }),
    ],
    [
      "assignEventStep kind",
      (db, h) =>
        assignEventStep(db, {
          ...assignment,
          kind: h as "budget_sheet",
        }),
    ],
    [
      "unassignEventStep actor",
      (db, h) => unassignEventStep(db, { ...assignment, actorId: h }),
    ],
    [
      "completeEventStep event",
      (db, h) =>
        completeEventStep(db, {
          guildId: GUILD,
          eventId: h,
          kind: "budget_sheet",
          actorId: ACTOR,
        }),
    ],
    [
      "claimStepHandoff guild",
      (db, h) =>
        claimStepHandoff(db, { guildId: h, eventId: ID, kind: "budget_sheet" }),
    ],
    [
      "markStepHandoffSent kind",
      (db, h) =>
        markStepHandoffSent(db, {
          guildId: GUILD,
          eventId: ID,
          kind: h as "budget_sheet",
        }),
    ],
    [
      "setEventPickupTime time",
      (db, h) =>
        setEventPickupTime(db, {
          guildId: GUILD,
          eventId: ID,
          pickupTime: h,
          actorId: ACTOR,
        }),
    ],
    [
      "listOpenStepsForUser user",
      (db, h) =>
        listOpenStepsForUser(db, { guildId: GUILD, userId: h, today: DATE }),
    ],
    [
      "listOpenStepsForUser date",
      (db, h) =>
        listOpenStepsForUser(db, {
          guildId: GUILD,
          userId: USER,
          today: h as DateOnly,
        }),
    ],
    [
      "listEventReminderCandidates",
      (db, h) => listEventReminderCandidates(db, { fromDate: h as DateOnly }),
    ],
    [
      "claimEventReminder event",
      (db, h) => claimEventReminder(db, { ...reminderKey, eventId: h }),
    ],
    [
      "claimEventReminder kind",
      (db, h) =>
        claimEventReminder(db, {
          ...reminderKey,
          kind: h as "daily_steps",
        }),
    ],
    [
      "reclaimEventReminder token",
      (db, h) => reclaimEventReminder(db, { ...reminderKey, claimToken: h }),
    ],
    [
      "markEventReminderSent message",
      (db, h) =>
        markEventReminderSent(db, {
          ...reminderKey,
          claimToken: TOKEN,
          messageId: h,
        }),
    ],
    [
      "markEventReminderSkipped date",
      (db, h) =>
        markEventReminderSkipped(db, {
          ...reminderKey,
          reminderDate: h as DateOnly,
          claimToken: TOKEN,
        }),
    ],
    [
      "saveSetupDraft role",
      (db, h) =>
        saveSetupDraft(db, {
          guildId: GUILD,
          actorId: ACTOR,
          roles: { ...ROLES, treasuryRoleId: h },
        }),
    ],
    [
      "getSetupDraft fingerprint",
      (db, h) =>
        getSetupDraft(db, {
          guildId: GUILD,
          actorId: ACTOR,
          fingerprint: h,
          now: NOW,
        }),
    ],
  ];

  describe.each(calls)("%s", (_name, call) => {
    it.each(HOSTILE_STRINGS)("refuses %j", async (hostile) => {
      const { db, requests } = mockDb();
      const result = await call(db, hostile);
      expect(result).toEqual({
        ok: false,
        error: { category: "invalid_input", code: null },
      });
      expect(requests).toEqual([]);
    });
  });

  it.each([
    ["budget_approved", "assignEventStep", assignEventStep],
    ["budget_approved", "unassignEventStep", unassignEventStep],
  ] as const)("refuses %s for %s", async (kind, _name, call) => {
    const { db, requests } = mockDb();
    const result = await call(db, {
      ...assignment,
      kind: kind as "budget_sheet",
    });
    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it("refuses food_pickup as a step to complete or hand off", async () => {
    const { db, requests } = mockDb();
    const key = {
      guildId: GUILD,
      eventId: ID,
      kind: "food_pickup" as "budget_sheet",
    };
    expect((await completeEventStep(db, { ...key, actorId: ACTOR })).ok).toBe(
      false,
    );
    expect((await claimStepHandoff(db, key)).ok).toBe(false);
    expect(requests).toEqual([]);
  });

  it.each(["5:30", "24:00", "17:60", "17:30:00", "5:30 PM", " 17:30"])(
    "refuses the pickup time %j",
    async (pickupTime) => {
      const { db, requests } = mockDb();
      const result = await setEventPickupTime(db, {
        guildId: GUILD,
        eventId: ID,
        pickupTime,
        actorId: ACTOR,
      });
      expect(result.ok).toBe(false);
      expect(requests).toEqual([]);
    },
  );

  it("refuses more than 100 events in one read, and reads nothing for none", async () => {
    const { db, requests } = mockDb();
    const many = Array.from({ length: 101 }, () => ID);
    expect(
      (await listEventWorkflows(db, { guildId: GUILD, eventIds: many })).ok,
    ).toBe(false);
    expect(
      await listEventWorkflows(db, { guildId: GUILD, eventIds: [] }),
    ).toEqual({ ok: true, value: { rows: [], excluded: [] } });
    expect(requests).toEqual([]);
  });

  it("refuses the guild ID as any of the six roles", async () => {
    const { db, requests } = mockDb();
    for (const role of Object.keys(ROLES) as (keyof SetupRoles)[]) {
      const result = await saveSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        roles: { ...ROLES, [role]: GUILD },
      });
      expect(result.ok).toBe(false);
    }
    expect(requests).toEqual([]);
  });

  it("refuses an invalid instant", async () => {
    const { db, requests } = mockDb();
    const bad = new Date(Number.NaN);
    expect(
      (await listStaleEventReminderClaims(db, { claimedBefore: bad })).ok,
    ).toBe(false);
    expect(
      (
        await getSetupDraft(db, {
          guildId: GUILD,
          actorId: ACTOR,
          fingerprint: setupDraftFingerprint(ROLES),
          now: bad,
        })
      ).ok,
    ).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("reading answers", () => {
  it("orders a workflow's steps by kind and its people oldest first, as HH:MM", async () => {
    const { db } = mockDb(() => ({ rows: values(workflowRow()) }));
    const result = await getEventWorkflow(db, { guildId: GUILD, eventId: ID });
    expect(result.ok).toBe(true);
    const workflow = result.ok ? result.value : null;
    expect(workflow?.pickup_time).toBe("17:30");
    expect(workflow?.steps.map((row) => [row.kind, row.status])).toEqual([
      ["budget_sheet", "done"],
      ["engage_post", "open"],
      ["budget_approved", "done"],
      ["food_pickup", "open"],
    ]);
    expect(workflow?.assignees.map((row) => row.kind)).toEqual([
      "budget_sheet",
      "engage_post",
    ]);
  });

  it("returns null for an event that is not there", async () => {
    const { db } = mockDb(() => ({ rows: [] }));
    expect(await getEventWorkflow(db, { guildId: GUILD, eventId: ID })).toEqual(
      { ok: true, value: null },
    );
  });

  it("treats a workflow with a step missing as a bad row", async () => {
    const row = workflowRow();
    row.event_steps.pop();
    const { db } = mockDb(() => ({ rows: values(row) }));
    expect(await getEventWorkflow(db, { guildId: GUILD, eventId: ID })).toEqual(
      { ok: false, error: { category: "bad_row", code: null } },
    );
  });

  it.each([
    [
      "assignEventStep",
      (db: ReturnType<typeof mockDb>["db"]) => assignEventStep(db, assignment),
    ],
    [
      "unassignEventStep",
      (db: ReturnType<typeof mockDb>["db"]) =>
        unassignEventStep(db, assignment),
    ],
    [
      "completeEventStep",
      (db: ReturnType<typeof mockDb>["db"]) =>
        completeEventStep(db, {
          guildId: GUILD,
          eventId: ID,
          kind: "budget_sheet",
          actorId: ACTOR,
        }),
    ],
    [
      "setEventPickupTime",
      (db: ReturnType<typeof mockDb>["db"]) =>
        setEventPickupTime(db, {
          guildId: GUILD,
          eventId: ID,
          pickupTime: "09:05",
          actorId: ACTOR,
        }),
    ],
  ])("reports a null from %s as not found", async (_name, call) => {
    const { db } = mockDb(() => ({ value: null }));
    expect(await call(db)).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it.each([
    ["CF431", "step_assignee_limit"],
    ["CF410", "parent_unavailable"],
  ])("reports %s as %s", async (code, category) => {
    const { db } = mockDb(() => ({ error: code }));
    expect(await assignEventStep(db, assignment)).toEqual({
      ok: false,
      error: { category, code },
    });
  });

  it("lists open steps and upcoming pickups only, soonest first", async () => {
    const event = (id: string, date: string, budgetSheet: string) => ({
      id,
      name: "Social",
      event_date: date,
      pickup_time: null,
      event_steps: [
        { kind: "budget_sheet", status: budgetSheet },
        { kind: "engage_post", status: "open" },
        { kind: "budget_approved", status: "open" },
        { kind: "food_pickup", status: "open" },
      ],
    });
    const later = event(ID, "2030-02-01", "open");
    const sooner = event(OTHER_ID, "2030-01-20", "done");
    const past = event(OTHER_ID, "2030-01-01", "open");
    const { db } = mockDb(() => ({
      rows: values(
        { id: ID, kind: "budget_sheet", events: later },
        { id: TOKEN, kind: "budget_sheet", events: sooner },
        { id: OTHER_ID, kind: "food_pickup", events: sooner },
        { id: CREATED_ID, kind: "food_pickup", events: past },
        { id: SECOND_ID, kind: "engage_post", events: sooner },
      ),
    }));
    const result = await listOpenStepsForUser(db, {
      guildId: GUILD,
      userId: USER,
      today: DATE,
    });
    expect(
      result.ok
        ? result.value.rows.map((row) => [row.event_date, row.kind])
        : null,
    ).toEqual([
      ["2030-01-20", "engage_post"],
      ["2030-01-20", "food_pickup"],
      ["2030-02-01", "budget_sheet"],
    ]);
  });

  it("reads a reminder candidate with its guild's zone and Events Directors role", async () => {
    const role = testSnowflake();
    const { db } = mockDb(() => ({
      rows: values({
        id: ID,
        guild_id: GUILD,
        name: "Social",
        event_date: DATE,
        thread_id: USER,
        thread_status: "active",
        created_by: ACTOR,
        thread_refusals: 0,
        pickup_time: "09:05:00",
        managed_channels: {
          guild_config: {
            timezone: "America/New_York",
            officer_role_id: role,
          },
        },
        event_steps: [{ kind: "budget_sheet", status: "open" }],
        event_step_assignees: [
          {
            id: OTHER_ID,
            kind: "budget_sheet",
            user_id: USER,
            created_at: "2030-01-02T00:00:00+00:00",
          },
          {
            id: ID,
            kind: "food_pickup",
            user_id: ACTOR,
            created_at: "2030-01-01T00:00:00+00:00",
          },
        ],
        event_reminder_log: [
          {
            kind: "daily_steps",
            reminder_date: DATE,
            state: "sent",
            claimed_at: CREATED,
          },
        ],
      }),
    }));
    const result = await listEventReminderCandidates(db, { fromDate: DATE });
    expect(result.ok && result.value.rows[0]).toMatchObject({
      timezone: "America/New_York",
      events_director_role_id: role,
      pickup_time: "09:05",
      assignees: [
        { kind: "food_pickup", user_id: ACTOR },
        { kind: "budget_sheet", user_id: USER },
      ],
      log: [{ kind: "daily_steps", reminder_date: DATE, state: "sent" }],
    });
  });
});

const CREATED_ID = "11111111-2222-4333-8444-777777777777";
const SECOND_ID = "11111111-2222-4333-8444-888888888888";

describe("setup drafts", () => {
  function draftRow(fields: Record<string, unknown> = {}) {
    return {
      guild_id: GUILD,
      actor_id: ACTOR,
      officer_role_id: ROLES.officerRoleId,
      admin_role_id: ROLES.adminRoleId,
      eboard_role_id: ROLES.eboardRoleId,
      events_committee_role_id: ROLES.eventsCommitteeRoleId,
      treasury_role_id: ROLES.treasuryRoleId,
      marketing_role_id: ROLES.marketingRoleId,
      fingerprint: setupDraftFingerprint(ROLES),
      created_at: CREATED,
      ...fields,
    };
  }

  it("fingerprints the six roles in order, in a short custom_id-safe form", () => {
    const fingerprint = setupDraftFingerprint(ROLES);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(setupDraftFingerprint({ ...ROLES })).toBe(fingerprint);
    expect(
      setupDraftFingerprint({
        ...ROLES,
        treasuryRoleId: ROLES.marketingRoleId,
        marketingRoleId: ROLES.treasuryRoleId,
      }),
    ).not.toBe(fingerprint);
  });

  it("returns the fingerprint it saved", async () => {
    const { db } = mockDb(() => ({ value: true }));
    expect(
      await saveSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        roles: ROLES,
      }),
    ).toEqual({ ok: true, value: setupDraftFingerprint(ROLES) });
  });

  it("reads a draft back, and gives its roles in the bindings' shape", async () => {
    const { db } = mockDb(() => ({ rows: values(draftRow()) }));
    const result = await getSetupDraft(db, {
      guildId: GUILD,
      actorId: ACTOR,
      fingerprint: setupDraftFingerprint(ROLES),
      now: NOW,
    });
    expect(
      result.ok && result.value !== null && draftRoles(result.value),
    ).toEqual(ROLES);
  });

  it("ignores a stored draft whose fingerprint does not match its roles", async () => {
    const { db } = mockDb(() => ({
      rows: values(draftRow({ treasury_role_id: testSnowflake() })),
    }));
    expect(
      await getSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        fingerprint: setupDraftFingerprint(ROLES),
        now: NOW,
      }),
    ).toEqual({ ok: true, value: null });
  });
});
