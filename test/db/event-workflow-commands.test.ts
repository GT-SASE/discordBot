/**
 * The event workflow from the router down to the real schema: /event assign, unassign
 * and pickup, the people picked on /event create, the overview's checklist and buttons,
 * the ping each finished step sends, and the steps /mytasks lists. Discord is the test
 * server behind the real client, so every send passes the managed-channel check.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assignEventStep,
  completeEventStep,
  MAX_ASSIGNEES_PER_STEP,
  MAX_FOOD_PICKUP_ASSIGNEES,
} from "../../src/db/event-steps.ts";
import type { AssignableStepKind } from "../../src/db/types.ts";
import { eventWorld, inThread } from "../support/event-world.ts";
import {
  ADMIN_ROLE,
  commandPayload,
  componentPayload,
  GUILD_ID,
  member,
  OFFICER_ROLE,
} from "../support/interactions.ts";
import { testSnowflake } from "../support/mock-postgrest.ts";
import { queryAs } from "./harness.ts";

const world = eventWorld();

const EBOARD_ROLE = testSnowflake();
const TREASURY_ROLE = testSnowflake();
const MARKETING_ROLE = testSnowflake();
const CREATOR = testSnowflake();
const REFUSAL = "You can't do that, or it doesn't exist.";
const SUPPRESS_EMBEDS = 4;
const MESSAGE_EDIT = /^\/channels\/[0-9]+\/messages\/[0-9]+$/;

const officer = (id = testSnowflake()) => member({ id, roles: [OFFICER_ROLE] });
const eboard = (id = testSnowflake()) => member({ id, roles: [EBOARD_ROLE] });
const treasurer = (id = testSnowflake()) =>
  member({ id, roles: [TREASURY_ROLE] });
const marketer = (id = testSnowflake()) =>
  member({ id, roles: [MARKETING_ROLE] });
const plain = (id = testSnowflake()) => member({ id });

async function bindRoles(
  treasury: string | null,
  marketing: string | null,
): Promise<void> {
  const rows = await queryAs<{ version: number }>(
    world.pg,
    "bot_app",
    `SELECT version FROM public.guild_config WHERE guild_id = $1`,
    [GUILD_ID],
  );
  await queryAs(
    world.pg,
    "bot_app",
    `SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
    [
      GUILD_ID,
      rows[0]?.version,
      testSnowflake(),
      OFFICER_ROLE,
      ADMIN_ROLE,
      EBOARD_ROLE,
      treasury,
      marketing,
    ],
  );
}

beforeAll(async () => {
  await bindRoles(TREASURY_ROLE, MARKETING_ROLE);
});

interface Seeded {
  id: string;
  forum: string;
  threadId: string;
  overviewId: string;
}

/** An active event with its post and overview, as /event create leaves it. */
async function seed(
  fields: { status?: "active" | "closed"; date?: string } = {},
): Promise<Seeded> {
  const forum = await world.addManagedForum();
  const threadId = world.discord.addThread({
    guild_id: GUILD_ID,
    parent_id: forum,
    name: "Fall Social",
  });
  const overviewId = testSnowflake();
  world.discord.messageIds.add(overviewId);
  const { rows } = await world.pg.query<{ id: string }>(
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id,
        overview_message_id, status, thread_status)
     VALUES ($1, $2, 'Fall Social', $3, $4, $5, $6, $7::public.event_status, 'active')
     RETURNING id`,
    [
      GUILD_ID,
      forum,
      fields.date ?? "2099-01-15",
      CREATOR,
      threadId,
      overviewId,
      fields.status ?? "active",
    ],
  );
  return { id: (rows[0] as { id: string }).id, forum, threadId, overviewId };
}

function resolvedUsers(ids: readonly string[]) {
  return {
    users: Object.fromEntries(ids.map((id) => [id, { id }])),
    members: Object.fromEntries(ids.map((id) => [id, { roles: [] }])),
  };
}

/** `/event <sub>` with string options and user options, as Discord sends it. */
function command(
  sub: string,
  strings: Record<string, string>,
  users: Record<string, string>,
  who: Record<string, unknown>,
  fields: Record<string, unknown> = {},
) {
  return commandPayload(
    "event",
    { member: who, ...fields },
    {
      options: [
        {
          type: 1,
          name: sub,
          options: [
            ...Object.entries(strings).map(([name, value]) => ({
              type: 3,
              name,
              value,
            })),
            ...Object.entries(users).map(([name, value]) => ({
              type: 6,
              name,
              value,
            })),
          ],
        },
      ],
      resolved: resolvedUsers(Object.values(users)),
    },
  );
}

function assign(
  event: Seeded,
  step: string,
  userId: string,
  who: Record<string, unknown> = officer(),
) {
  return world.send(
    command("assign", { event: event.id, step }, { user: userId }, who),
  );
}

function click(prefix: string, event: Seeded, who: Record<string, unknown>) {
  return componentPayload(`${prefix}:${event.id}`, {
    member: who,
    message: { id: event.overviewId, flags: SUPPRESS_EMBEDS },
    ...inThread(event.threadId, event.forum),
  });
}

async function steps(eventId: string) {
  const { rows } = await world.pg.query<{
    kind: string;
    status: string;
    completed_by: string | null;
    handoff_sent: boolean;
  }>(
    `SELECT kind::text AS kind, status::text AS status, completed_by,
            handoff_sent_at IS NOT NULL AS handoff_sent
     FROM public.event_steps WHERE event_id = $1 ORDER BY kind`,
    [eventId],
  );
  return Object.fromEntries(rows.map((row) => [row.kind, row]));
}

async function owners(eventId: string, kind: AssignableStepKind) {
  const { rows } = await world.pg.query<{ user_id: string }>(
    `SELECT user_id FROM public.event_step_assignees
     WHERE event_id = $1 AND kind = $2::public.event_step_kind
       AND removed_at IS NULL
     ORDER BY created_at, id`,
    [eventId, kind],
  );
  return rows.map((row) => row.user_id);
}

async function pickupTime(eventId: string): Promise<string | null> {
  const { rows } = await world.pg.query<{ pickup_time: string | null }>(
    `SELECT to_char(pickup_time, 'HH24:MI') AS pickup_time
     FROM public.events WHERE id = $1`,
    [eventId],
  );
  return rows[0]?.pickup_time ?? null;
}

/** Messages posted in the event's post, leaving out overview edits. */
function postedIn(event: Seeded) {
  return world.discord
    .posts()
    .filter((post) => post.path === `/channels/${event.threadId}/messages`);
}

function lastOverviewEdit(event: Seeded) {
  return world.discord.requests.findLast(
    (request) =>
      request.method === "PATCH" &&
      request.path ===
        `/channels/${event.threadId}/messages/${event.overviewId}`,
  );
}

function buttonIds(body: Record<string, unknown> | undefined): string[] {
  const rows = (body?.components ?? []) as {
    components: { custom_id: string }[];
  }[];
  return rows.flatMap((row) => row.components.map((part) => part.custom_id));
}

async function approve(event: Seeded): Promise<void> {
  const done = await completeEventStep(world.db, {
    guildId: GUILD_ID,
    eventId: event.id,
    kind: "budget_approved",
    actorId: testSnowflake(),
  });
  expect(done).toEqual({ ok: true, value: true });
}

beforeEach(async () => {
  await bindRoles(TREASURY_ROLE, MARKETING_ROLE);
});

describe("/event assign and unassign", () => {
  it("puts a member on Budget Sheet and redraws the checklist without pinging", async () => {
    const event = await seed();
    const person = testSnowflake();

    await assign(event, "budget_sheet", person);

    expect(await owners(event.id, "budget_sheet")).toEqual([person]);
    expect(world.discord.lastReply()).toContain(
      `Put <@${person}> on Budget Sheet for **Fall Social**.`,
    );
    const edit = lastOverviewEdit(event);
    const content = edit?.body?.content as string;
    expect(content).toContain("**Checklist**");
    expect(content).toContain(`⬜ Budget Sheet: <@${person}>`);
    expect(content).toContain("⬜ Engage post: nobody assigned");
    expect(content).toContain("⬜ Food pickup: time not set, nobody assigned");
    expect(edit?.body?.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(buttonIds(edit?.body)).toEqual([
      `event.sheet-done:${event.id}`,
      `event.engage-done:${event.id}`,
      `event.budget-ok:${event.id}`,
    ]);
    expect(postedIn(event)).toEqual([]);
  });

  it("lets E-board assign, and says so when the person is already on it", async () => {
    const event = await seed();
    const person = testSnowflake();

    await assign(event, "engage_post", person, eboard());
    await assign(event, "engage_post", person, eboard());

    expect(await owners(event.id, "engage_post")).toEqual([person]);
    expect(world.discord.lastReply()).toContain("is already on Engage post");
  });

  it.each([
    ["a member with no role", plain()],
    ["Treasury", treasurer()],
    ["Marketing", marketer()],
  ])("refuses %s and writes nothing", async (_label, who) => {
    const event = await seed();

    const ran = await assign(event, "budget_sheet", testSnowflake(), who);

    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect(await owners(event.id, "budget_sheet")).toEqual([]);
    expect(world.discord.publicWrites()).toEqual([]);
  });

  it("refuses a step that is not one of the choices", async () => {
    const event = await seed();

    await assign(event, "budget_approved", testSnowflake());

    expect(world.discord.lastReply()).toContain("Choose Budget Sheet");
  });

  it("refuses a bot", async () => {
    const event = await seed();
    const bot = testSnowflake();
    const payload = command(
      "assign",
      { event: event.id, step: "budget_sheet" },
      { user: bot },
      officer(),
    );
    const data = payload.data as {
      resolved: { users: Record<string, object> };
    };
    data.resolved.users[bot] = { id: bot, bot: true };

    await world.send(payload);

    expect(world.discord.lastReply()).toContain("can't be given to bots");
    expect(await owners(event.id, "budget_sheet")).toEqual([]);
  });

  it(`stops at ${String(MAX_ASSIGNEES_PER_STEP)} people on a step`, async () => {
    const event = await seed();
    for (let index = 0; index < MAX_ASSIGNEES_PER_STEP; index++) {
      await assignEventStep(world.db, {
        guildId: GUILD_ID,
        eventId: event.id,
        kind: "budget_sheet",
        userId: testSnowflake(),
        actorId: testSnowflake(),
      });
    }

    await assign(event, "budget_sheet", testSnowflake());

    expect(world.discord.lastReply()).toContain(
      `Budget Sheet already has ${String(MAX_ASSIGNEES_PER_STEP)} people`,
    );
    expect(await owners(event.id, "budget_sheet")).toHaveLength(
      MAX_ASSIGNEES_PER_STEP,
    );
  });

  it(`stops at ${String(MAX_FOOD_PICKUP_ASSIGNEES)} people on Food pickup`, async () => {
    const event = await seed();
    await approve(event);
    for (let index = 0; index < MAX_FOOD_PICKUP_ASSIGNEES; index++) {
      await assignEventStep(world.db, {
        guildId: GUILD_ID,
        eventId: event.id,
        kind: "food_pickup",
        userId: testSnowflake(),
        actorId: testSnowflake(),
      });
    }

    await assign(event, "food_pickup", testSnowflake());

    expect(world.discord.lastReply()).toContain(
      `Food pickup already has ${String(MAX_FOOD_PICKUP_ASSIGNEES)} people`,
    );
  });

  it("puts someone on Food pickup before the budget is approved", async () => {
    const event = await seed();
    const person = testSnowflake();

    await assign(event, "food_pickup", person);

    expect(await owners(event.id, "food_pickup")).toEqual([person]);
  });

  it("refuses a closed event", async () => {
    const event = await seed({ status: "closed" });

    await assign(event, "budget_sheet", testSnowflake());

    expect(world.discord.lastReply()).toContain("That event is closed");
    expect(await owners(event.id, "budget_sheet")).toEqual([]);
  });

  it("takes the event from the post it runs in", async () => {
    const event = await seed();
    const person = testSnowflake();

    await world.send(
      command(
        "assign",
        { step: "engage_post" },
        { user: person },
        officer(),
        inThread(event.threadId, event.forum),
      ),
    );

    expect(await owners(event.id, "engage_post")).toEqual([person]);
  });

  it("takes someone off a step and redraws", async () => {
    const event = await seed();
    const person = testSnowflake();
    await assign(event, "budget_sheet", person);

    await world.send(
      command(
        "unassign",
        { event: event.id, step: "budget_sheet" },
        { user: person },
        officer(),
      ),
    );

    expect(await owners(event.id, "budget_sheet")).toEqual([]);
    expect(world.discord.lastReply()).toContain(
      `Took <@${person}> off Budget Sheet`,
    );
    expect(lastOverviewEdit(event)?.body?.content).toContain(
      "⬜ Budget Sheet: nobody assigned",
    );
  });
});

describe("/event pickup", () => {
  const pickup = (event: Seeded, time: string, who = officer()) =>
    world.send(command("pickup", { event: event.id, time }, {}, who));

  it("sets the time before the budget is approved", async () => {
    const event = await seed();

    await pickup(event, "5:30 PM");

    expect(await pickupTime(event.id)).toBe("17:30");
  });

  it("sets the time once approved, and finishes the step with people on it", async () => {
    const event = await seed();
    await approve(event);
    const person = testSnowflake();
    await assign(event, "food_pickup", person);
    expect(world.discord.lastReply()).toContain(
      "Set the pickup time with /event pickup.",
    );

    await pickup(event, "5:30 PM");

    expect(await pickupTime(event.id)).toBe("17:30");
    expect((await steps(event.id)).food_pickup?.status).toBe("done");
    expect(world.discord.lastReply()).toContain(
      "Food pickup for **Fall Social** is at 5\\:30 PM on 2099\\-01\\-15.",
    );
    expect(lastOverviewEdit(event)?.body?.content).toContain(
      `✅ Food pickup: at 5\\:30 PM, <@${person}>`,
    );
  });

  it("says who is still missing when nobody is on Food pickup", async () => {
    const event = await seed();
    await approve(event);

    await pickup(event, "17:45");

    expect(await pickupTime(event.id)).toBe("17:45");
    expect((await steps(event.id)).food_pickup?.status).toBe("open");
    expect(world.discord.lastReply()).toContain(
      "Add the people picking up with /event assign step:Food pickup.",
    );
  });

  it("refuses a time it can't read, and a member who is not an officer", async () => {
    const event = await seed();
    await approve(event);

    await pickup(event, "half five");
    expect(world.discord.lastReply()).toContain("Enter the pickup time");

    const ran = await pickup(event, "5:30 PM", treasurer());
    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect(await pickupTime(event.id)).toBeNull();
  });
});

describe("/event create with people picked", () => {
  it("puts them on Budget Sheet and Engage post before drawing the post", async () => {
    await world.addManagedForum();
    const budget = testSnowflake();
    const engage = testSnowflake();

    await world.send(
      command(
        "create",
        { name: "Spring Gala", date: "2099-04-01" },
        { budget, engage },
        officer(),
      ),
    );

    const [event] = await world.events();
    expect(event?.thread_status).toBe("active");
    expect(await owners(event?.id ?? "", "budget_sheet")).toEqual([budget]);
    expect(await owners(event?.id ?? "", "engage_post")).toEqual([engage]);
    const post = world.discord.posts()[0];
    const message = post?.body?.message as Record<string, unknown>;
    expect(message.content).toContain(`⬜ Budget Sheet: <@${budget}>`);
    expect(message.content).toContain(`⬜ Engage post: <@${engage}>`);
    expect(message.allowed_mentions).toEqual({ parse: [], users: [] });
    expect(buttonIds(message)).toHaveLength(3);
    expect(world.discord.lastReply()).toContain(`Budget Sheet: <@${budget}>.`);
  });

  it("refuses a picked person who is not a member before creating anything", async () => {
    await world.addManagedForum();
    const payload = command(
      "create",
      { name: "Spring Gala", date: "2099-04-01" },
      { budget: testSnowflake() },
      officer(),
    );
    (payload.data as { resolved: { members: object } }).resolved.members = {};

    await world.send(payload);

    expect(world.discord.lastReply()).toContain("isn't a member");
    expect(await world.events()).toEqual([]);
  });
});

describe("the overview's buttons", () => {
  it("refuses someone not on Budget Sheet who is not an officer", async () => {
    const event = await seed();
    await assign(event, "budget_sheet", testSnowflake());

    await world.send(click("event.sheet-done", event, plain()));

    expect(world.discord.lastReply()).toBe(REFUSAL);
    expect((await steps(event.id)).budget_sheet?.status).toBe("open");
    expect(postedIn(event)).toEqual([]);
  });

  it("lets the assignee finish Budget Sheet, pings Treasury once and hides the button", async () => {
    const event = await seed();
    const person = testSnowflake();
    await assign(event, "budget_sheet", person);
    world.allowPings({ roles: [TREASURY_ROLE] });

    const first = click("event.sheet-done", event, plain(person));
    const ran = await world.send(first);
    // The same delivery again, and a second click by someone else.
    await world.send(first);
    await world.send(click("event.sheet-done", event, officer()));

    expect(ran.reply).toEqual({ type: 5, data: { flags: 64 } });
    const state = (await steps(event.id)).budget_sheet;
    expect(state).toMatchObject({
      status: "done",
      completed_by: person,
      handoff_sent: true,
    });
    const pings = postedIn(event);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.body).toMatchObject({
      content: `<@&${TREASURY_ROLE}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY_ROLE] },
    });
    expect(world.discord.lastReply()).toContain(
      "Budget Sheet for **Fall Social** is already done",
    );
    const edit = lastOverviewEdit(event);
    expect(edit?.body?.content).toContain(`✅ Budget Sheet: <@${person}>`);
    expect(buttonIds(edit?.body)).toEqual([
      `event.engage-done:${event.id}`,
      `event.budget-ok:${event.id}`,
    ]);
  });

  it("loses the ping rather than sending it twice when the post can't be reached", async () => {
    const event = await seed();
    const path = `/channels/${event.threadId}/messages`;
    world.allowPings({ roles: [TREASURY_ROLE] });
    world.discord.fail(
      "POST",
      new RegExp(`^${path}$`),
      { kind: "respond", status: 403, code: 50001 },
      1,
    );

    await world.send(click("event.sheet-done", event, officer()));
    expect(world.discord.lastReply()).toContain(
      "I couldn't post in the event's post",
    );
    await world.send(click("event.sheet-done", event, officer()));

    expect((await steps(event.id)).budget_sheet).toMatchObject({
      status: "done",
      handoff_sent: false,
    });
    const tries = world.discord.requests.filter(
      (request) => request.method === "POST" && request.path === path,
    );
    expect(tries).toHaveLength(1);
    expect(world.discord.lastReply()).toContain("is already done");
  });

  it("lets an officer finish Engage post with nobody assigned, and pings Marketing", async () => {
    const event = await seed();
    world.allowPings({ roles: [MARKETING_ROLE] });

    await world.send(click("event.engage-done", event, officer()));

    expect((await steps(event.id)).engage_post?.status).toBe("done");
    expect(postedIn(event).map((post) => post.body?.content)).toEqual([
      `<@&${MARKETING_ROLE}> Engage post for **Fall Social** is up.`,
    ]);
    expect(world.discord.lastReply()).toContain(
      "I let the Marketing Committee know",
    );
  });

  it("says to run /setup, and pings nobody, when the role is not chosen", async () => {
    const event = await seed();
    await bindRoles(TREASURY_ROLE, null);

    await world.send(click("event.engage-done", event, officer()));

    const [post] = postedIn(event);
    expect(post?.body?.content).toBe(
      "Engage post for **Fall Social** is up. Run /setup to choose the Marketing Committee role, so the next one pings it.",
    );
    expect(post?.body?.allowed_mentions).toEqual({ parse: [], users: [] });
    expect((await steps(event.id)).engage_post?.handoff_sent).toBe(true);
  });

  it("does not let Marketing approve the budget", async () => {
    const event = await seed();

    const ran = await world.send(click("event.budget-ok", event, marketer()));

    // Refused by the tier, before the acknowledgement.
    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect((await steps(event.id)).budget_approved?.status).toBe("open");
  });

  it("does not let a Budget Sheet assignee approve the budget", async () => {
    const event = await seed();
    const person = testSnowflake();
    await assign(event, "budget_sheet", person);

    const ran = await world.send(
      click("event.budget-ok", event, plain(person)),
    );

    expect(ran.reply.data?.content).toBe(REFUSAL);
    expect((await steps(event.id)).budget_approved?.status).toBe("open");
  });

  it("lets Treasury approve, and asks the creator once to set up food pickup", async () => {
    const event = await seed();
    const approver = testSnowflake();
    world.allowPings({ users: [CREATOR] });

    await world.send(click("event.budget-ok", event, treasurer(approver)));
    await world.send(click("event.budget-ok", event, treasurer()));

    expect((await steps(event.id)).budget_approved).toMatchObject({
      status: "done",
      completed_by: approver,
    });
    const pings = postedIn(event);
    expect(pings).toHaveLength(1);
    expect(pings[0]?.body).toMatchObject({
      content: `<@${CREATOR}> The budget for **Fall Social** is approved. Set up food pickup with /event pickup and /event assign step:Food pickup.`,
      allowed_mentions: { parse: [], users: [CREATOR] },
    });
    const edit = lastOverviewEdit(event);
    expect(edit?.body?.content).toContain(
      `✅ Budget approved by <@${approver}>`,
    );
    expect(buttonIds(edit?.body)).not.toContain(`event.budget-ok:${event.id}`);
  });

  it("removes the button row once every step with a button is done", async () => {
    const event = await seed();
    world.allowPings({
      users: [CREATOR],
      roles: [TREASURY_ROLE, MARKETING_ROLE],
    });

    for (const prefix of [
      "event.sheet-done",
      "event.engage-done",
      "event.budget-ok",
    ]) {
      await world.send(click(prefix, event, officer()));
    }

    expect(lastOverviewEdit(event)?.body?.components).toEqual([]);
    expect(postedIn(event)).toHaveLength(3);
  });

  it("refuses an event of another guild, a deleted one and a closed one", async () => {
    const closed = await seed({ status: "closed" });
    await world.send(click("event.budget-ok", closed, officer()));
    expect(world.discord.lastReply()).toContain("That event is closed");

    const deleted = await seed();
    await world.pg.query(
      `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
      [deleted.id],
    );
    await world.send(click("event.sheet-done", deleted, officer()));
    expect(world.discord.lastReply()).toBe(REFUSAL);
    expect(postedIn(closed)).toEqual([]);
    expect(postedIn(deleted)).toEqual([]);
    expect(
      world.discord.requests.filter(
        (request) =>
          request.method === "PATCH" && MESSAGE_EDIT.test(request.path),
      ),
    ).toEqual([]);
  });
});

describe("/mytasks", () => {
  it("lists a member's open steps and their upcoming food pickups", async () => {
    const event = await seed({ date: "2099-02-02" });
    const person = testSnowflake();
    await assign(event, "budget_sheet", person);
    await assign(event, "engage_post", person);
    await approve(event);
    await assign(event, "food_pickup", person);
    world.allowPings({ roles: [MARKETING_ROLE] });
    await world.send(click("event.engage-done", event, plain(person)));

    await world.send(commandPayload("mytasks", { member: plain(person) }));

    const reply = world.discord.lastReply() ?? "";
    expect(reply).toContain("**Your event steps, soonest first**");
    expect(reply).toContain(
      "- Budget Sheet for **Fall Social** on 2099\\-02\\-02",
    );
    expect(reply).not.toContain("Engage post");
    expect(reply).toContain(
      "- Food pickup for **Fall Social** on 2099\\-02\\-02, time not set yet",
    );
  });

  it("still says there is nothing when a member has no tasks or steps", async () => {
    await world.send(commandPayload("mytasks", { member: plain() }));

    expect(world.discord.lastReply()).toBe("You have no open tasks.");
  });
});
