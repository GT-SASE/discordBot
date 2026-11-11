/**
 * How many requests a command makes, counted at the two networks. Each count is the
 * number of sequential round trips the work costs, so a change that adds a lookup
 * shows up here instead of only in the latency.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventWorld, inThread } from "../support/event-world.ts";
import {
  commandPayload,
  GUILD_ID,
  member,
  OFFICER_ROLE,
} from "../support/interactions.ts";
import { testSnowflake } from "../support/mock-db.ts";

const world = eventWorld();

const GUILD_READ = /^\/guilds\/[0-9]+\/(?:roles|members\/[0-9]+)$/;
const CHANNEL_READ = /^\/channels\/([0-9]+)$/;
const VIEW_CHANNEL = 1n << 10n;

beforeEach(() => {
  // The test server has no reads of roles, members or overwrites, which the assignee
  // check makes. Answer them here: the forum is open to everyone, so the check passes.
  const server = world.discord;
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    const [input, init] = args;
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const path = url.pathname.replace(/^\/api\/v[0-9]+/, "");
    const forum = server.channels.get(CHANNEL_READ.exec(path)?.[1] ?? "");
    const read = (init?.method ?? "GET") === "GET";
    if (read && forum?.type === 15) {
      server.requests.push({ method: "GET", path, body: undefined });
      return Promise.resolve(
        Response.json({ ...forum, permission_overwrites: [] }),
      );
    }
    if (!read || !GUILD_READ.test(path)) {
      return server.fetch(...args);
    }
    server.requests.push({ method: "GET", path, body: undefined });
    return Promise.resolve(
      Response.json(
        path.endsWith("/roles")
          ? [
              {
                id: GUILD_ID,
                name: "@everyone",
                permissions: String(VIEW_CHANNEL),
                position: 0,
                managed: false,
              },
            ]
          : { roles: [] },
      ),
    );
  });
});

async function eventWithPost() {
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
     VALUES ($1, $2, 'Fall Social', '2099-01-15', $3, $4, $5, 'active', 'active')
     RETURNING id`,
    [GUILD_ID, forum, testSnowflake(), threadId, overviewId],
  );
  return { id: (rows[0] as { id: string }).id, forum, threadId };
}

function assignInThread(threadId: string, forum: string, person: string) {
  return commandPayload(
    "task",
    { member: member({ roles: [OFFICER_ROLE] }), ...inThread(threadId, forum) },
    {
      options: [
        {
          type: 1,
          name: "assign",
          options: [
            { type: 6, name: "person", value: person },
            { type: 3, name: "description", value: "Book the room" },
            { type: 3, name: "due", value: "2099-01-10" },
          ],
        },
      ],
      resolved: {
        users: { [person]: { id: person } },
        members: { [person]: { roles: [] } },
      },
    },
  );
}

describe("/task assign in an event's post", () => {
  it("checks the post's forum with one read and asks Discord nothing", async () => {
    const { forum, threadId } = await eventWithPost();
    const person = testSnowflake();
    world.allowPings({ users: [person] });

    const ran = await world.send(assignInThread(threadId, forum, person));

    expect(ran.deferred).toBe(true);
    const reply = world.discord.lastReply() ?? "";
    expect(reply).toContain("was mentioned");
    expect(reply).not.toContain("can't view");
    expect(world.errors).not.toHaveBeenCalled();
    const discord = world.discord.requests.map(
      ({ method, path }) => `${method} ${path}`,
    );
    // The notice and the overview edit each went through the managed check.
    expect(discord).toContain(`POST /channels/${threadId}/messages`);
    expect(
      discord.filter((line) => line.startsWith("PATCH /channels/")),
    ).toHaveLength(1);
    // The post itself is never looked up, and no forum is read from the guild's list.
    expect(discord).not.toContain(`GET /channels/${threadId}`);
    expect(discord.some((line) => line.endsWith("/channels"))).toBe(false);
    const forumChecks = world
      .dbRequests()
      .filter((line) => line.includes("managed_channels"));
    expect(forumChecks).toHaveLength(2);
    // Before: 9 Discord requests and 13 database requests. One read each of the event,
    // its tasks and its workflow after the overview edit checks that nothing it shows
    // changed while it was drawn.
    expect({
      discord: discord.length,
      db: world.dbRequests().length,
    }).toEqual({ discord: 7, db: 12 });
  });
});
