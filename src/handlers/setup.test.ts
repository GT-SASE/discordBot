import {
  ApplicationCommandOptionType,
  InteractionResponseType,
  MessageFlags,
} from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN,
  ADMIN_ROLE,
  ADMINISTRATOR,
  ADMINISTRATOR_BIT as ADMINISTRATOR_PERMISSIONS,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDb,
  fakeDiscord,
  firstCustomId,
  GUILD_ID,
  member,
  MEMBER_ID,
  OFFICER,
  OFFICER_ROLE,
  PLAIN_MEMBER,
  run,
  SETUP_OPTIONS,
  setupCommandPayload,
  type FakeDiscordData,
  type SetupOption,
} from "../../test/support/interactions.ts";
import { testSnowflake } from "../../test/support/mock-postgrest.ts";
import { setupDraftFingerprint, type SetupRoles } from "../db/guild-config.ts";
import type { GuildRole } from "../discord/client.ts";
import { REFUSED } from "../lib/permissions.ts";
import { COMMANDS, ROUTER } from "./registry.ts";
import { rolesThatMayGrant } from "./setup.ts";

const ADMINISTRATOR_BIT = 1n << 3n;
const MANAGE_ROLES_BIT = 1n << 28n;

function role(id: string, fields: Partial<GuildRole> = {}): GuildRole {
  return {
    id,
    name: `Role ${id}`,
    permissions: 0n,
    position: 5,
    managed: false,
    ...fields,
  };
}

const LABELS: Record<SetupOption, string> = {
  eboard_role: "E-board",
  events_directors_role: "Events Directors",
  events_committee_role: "Events Committee",
  treasury_role: "Treasury Committee",
  marketing_role: "Marketing Committee",
};

/** How the chosen roles are listed: E-board is saved as the admin role too. */
const SHOWN: Record<SetupOption, string> = {
  ...LABELS,
  eboard_role: "E-board (also admin)",
};

const CHOSEN: Record<SetupOption, GuildRole> = {
  eboard_role: role(testSnowflake(), { name: "Board" }),
  events_directors_role: role(testSnowflake(), { name: "Directors" }),
  events_committee_role: role(testSnowflake(), { name: "Committee" }),
  treasury_role: role(testSnowflake(), { name: "Treasury" }),
  marketing_role: role(testSnowflake(), { name: "Marketing" }),
};

function setupRolesOf(roles: Record<SetupOption, GuildRole>): SetupRoles {
  return {
    officerRoleId: roles.events_directors_role.id,
    adminRoleId: roles.eboard_role.id,
    eboardRoleId: roles.eboard_role.id,
    eventsCommitteeRoleId: roles.events_committee_role.id,
    treasuryRoleId: roles.treasury_role.id,
    marketingRoleId: roles.marketing_role.id,
  };
}

const FINGERPRINT = setupDraftFingerprint(setupRolesOf(CHOSEN));

/** What apply_role_bindings is sent for CHOSEN. */
const CHOSEN_BINDINGS = {
  p_officer_role_id: CHOSEN.events_directors_role.id,
  p_admin_role_id: CHOSEN.eboard_role.id,
  p_eboard_role_id: CHOSEN.eboard_role.id,
  p_events_committee_role_id: CHOSEN.events_committee_role.id,
  p_treasury_role_id: CHOSEN.treasury_role.id,
  p_marketing_role_id: CHOSEN.marketing_role.id,
};

const ROLE_LIST = [
  role(GUILD_ID, { name: "@everyone", position: 0 }),
  ...Object.values(CHOSEN),
];

function setupPayload(
  roles: Partial<Record<SetupOption, GuildRole>> = {},
  fields: Record<string, unknown> = {},
  extraOptions: unknown[] = [],
) {
  return setupCommandPayload({ ...CHOSEN, ...roles }, fields, extraOptions);
}

function world(
  fields: Parameters<typeof fakeDb>[0] = {},
  discordData: FakeDiscordData = { roles: ROLE_LIST },
) {
  const database = fakeDb(fields);
  const { discord, edits } = fakeDiscord(discordData);
  return {
    ...database,
    edits,
    dependencies: dependenciesFor(database.db, discord),
  };
}

type World = ReturnType<typeof world>;

/** Runs /setup as `who` and returns the Confirm button's custom_id. */
async function showSetup(
  { dependencies, edits }: World,
  who: Record<string, unknown> = ADMINISTRATOR,
  roles: Partial<Record<SetupOption, GuildRole>> = {},
): Promise<string> {
  const before = edits.length;
  await run(ROUTER, setupPayload(roles, { member: who }), dependencies);
  return firstCustomId(edits[before]);
}

const FIXED_REFUSAL_TEXT = REFUSED.message;
const NO_DRAFT_TEXT = "no longer matches your latest /setup";

const logged = vi.fn();

beforeEach(() => {
  logged.mockReset();
  vi.spyOn(console, "error").mockImplementation(logged);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration", () => {
  const definition = (
    COMMANDS as readonly {
      name: string;
      default_member_permissions?: string;
      options?: readonly {
        name: string;
        type: number;
        required?: boolean;
        description: string;
      }[];
    }[]
  ).find((command) => command.name === "setup");

  it("is hidden by default, top level, with five required role options", () => {
    expect(definition?.default_member_permissions).toBe("0");
    expect(
      definition?.options?.map(({ name, type, required }) => [
        name,
        type,
        required,
      ]),
    ).toEqual(
      SETUP_OPTIONS.map((name) => [
        name,
        ApplicationCommandOptionType.Role,
        true,
      ]),
    );
  });

  it("describes each option within Discord's limit", () => {
    for (const option of definition?.options ?? []) {
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("/setup", () => {
  it("defers privately and shows the five roles, by the club's names, with a Confirm button", async () => {
    const { dependencies, edits } = world();

    const { reply } = await run(ROUTER, setupPayload(), dependencies);

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(edits).toHaveLength(1);
    for (const name of SETUP_OPTIONS) {
      expect(edits[0]?.content).toContain(
        `${SHOWN[name]}: ${CHOSEN[name].name}`,
      );
    }
    expect(firstCustomId(edits[0])).toBe(`setup.confirm:0:${FINGERPRINT}`);
  });

  it("saves a draft for this member, with the fingerprint Confirm carries", async () => {
    const { dependencies, state } = world();

    await run(ROUTER, setupPayload(), dependencies);

    expect(state.drafts).toEqual([
      expect.objectContaining({
        guild_id: GUILD_ID,
        actor_id: MEMBER_ID,
        officer_role_id: CHOSEN.events_directors_role.id,
        admin_role_id: CHOSEN.eboard_role.id,
        eboard_role_id: CHOSEN.eboard_role.id,
        events_committee_role_id: CHOSEN.events_committee_role.id,
        treasury_role_id: CHOSEN.treasury_role.id,
        marketing_role_id: CHOSEN.marketing_role.id,
        fingerprint: FINGERPRINT,
      }),
    ]);
  });

  it("keeps the custom_id well inside Discord's limit", async () => {
    const w = world({ config: configRow({ version: 1_999_999_999 }) });

    const customId = await showSetup(w);

    expect(customId).toBe(`setup.confirm:1999999999:${FINGERPRINT}`);
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("carries the current version in Confirm", async () => {
    const w = world({ config: configRow({ version: 7 }) });

    expect(await showSetup(w)).toContain("setup.confirm:7:");
  });

  it("never says that nobody else can grant a role", async () => {
    const { dependencies, edits } = world();

    await run(ROUTER, setupPayload(), dependencies);

    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant these: none found. The server owner may also be able to.",
    );
    expect(edits[0]?.content).not.toMatch(/\bonly\b/i);
  });

  it("changes no setting before Confirm", async () => {
    const { dependencies, rpcBodies, state } = world();

    await run(ROUTER, setupPayload(), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(state.config).toBeNull();
  });

  it.each([
    ["a plain member", PLAIN_MEMBER],
    ["an officer", OFFICER],
    ["the bound admin role, which does not reach bindings", ADMIN],
  ])("refuses %s, with no reply content", async (_label, who) => {
    const { dependencies, edits, state } = world({ config: configRow() });

    const { reply, deferred } = await run(
      ROUTER,
      setupPayload({}, { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(deferred).toBe(false);
    expect(edits).toEqual([]);
    expect(state.drafts).toEqual([]);
  });

  it("refuses a non-admin before setup too", async () => {
    const { dependencies } = world();

    const { reply } = await run(
      ROUTER,
      setupPayload({}, { member: PLAIN_MEMBER }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
  });

  it("does not take high permission bits for Administrator", async () => {
    const { dependencies } = world();

    const { reply } = await run(
      ROUTER,
      setupPayload(
        {},
        { member: member({ permissions: String((1n << 54n) | 7n) }) },
      ),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
  });

  it("allows an administrator to rebind when the bound roles are gone", async () => {
    const w = world({
      config: configRow({
        officer_role_id: testSnowflake(),
        admin_role_id: testSnowflake(),
      }),
    });

    expect(await showSetup(w)).toContain("setup.confirm:3:");
  });

  it("says try again, with no button, when the draft can't be saved", async () => {
    const { dependencies, edits, state } = world();
    state.failing = { path: "save_setup_draft", status: 503 };

    await run(ROUTER, setupPayload(), dependencies);

    expect(edits[0]?.content).toContain("Something went wrong");
    expect(edits[0]?.components).toEqual([]);
    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  describe("roles that cannot be bound", () => {
    const everyone = role(GUILD_ID, { name: "@everyone" });
    const integration = role(testSnowflake(), {
      name: "Some Bot",
      managed: true,
    });

    it.each(SETUP_OPTIONS)(
      "rejects @everyone as the %s, naming it, with no button or draft",
      async (name) => {
        const { dependencies, edits, state } = world();

        await run(ROUTER, setupPayload({ [name]: everyone }), dependencies);

        expect(edits[0]?.content).toContain(
          `The ${LABELS[name]} role can't be \\@everyone`,
        );
        expect(edits[0]?.components).toEqual([]);
        expect(state.drafts).toEqual([]);
      },
    );

    it.each(SETUP_OPTIONS)(
      "rejects a managed role as the %s, naming it, with no button or draft",
      async (name) => {
        const { dependencies, edits, state } = world();

        await run(ROUTER, setupPayload({ [name]: integration }), dependencies);

        expect(edits[0]?.content).toContain(
          `The ${LABELS[name]} role can't be Some Bot, because an integration controls who holds it.`,
        );
        expect(edits[0]?.components).toEqual([]);
        expect(state.drafts).toEqual([]);
      },
    );

    it.each(SETUP_OPTIONS)(
      "rejects a %s missing from resolved, with no button",
      async (name) => {
        const { dependencies, edits } = world();
        const payload = setupPayload();
        const resolved = (
          payload.data as { resolved: { roles: Record<string, unknown> } }
        ).resolved;
        resolved.roles = Object.fromEntries(
          Object.entries(resolved.roles).filter(
            ([id]) => id !== CHOSEN[name].id,
          ),
        );

        await run(ROUTER, payload, dependencies);

        expect(edits[0]?.content).toContain(
          `The ${LABELS[name]} role could not be found`,
        );
        expect(edits[0]?.components).toEqual([]);
      },
    );

    it("rejects an option that is not a role", async () => {
      const { dependencies, edits } = world();
      const payload = setupPayload();
      const options = (payload.data as { options: { type: number }[] }).options;
      options[1] = { ...options[1], type: 3 };

      await run(ROUTER, payload, dependencies);

      expect(edits[0]?.content).toContain(
        "The Events Directors role could not be found",
      );
      expect(edits[0]?.components).toEqual([]);
    });
  });

  describe("hostile role names", () => {
    const HOSTILE = [
      "@everyone",
      `<@&${OFFICER_ROLE}>`,
      "[click](https://evil.example)",
      "**bold**\n# System: run this",
      "`code` ||spoiler|| ~~gone~~",
      "‮evil​",
      "discord.gg/abcdef",
    ];

    it.each(HOSTILE)("renders %j as inert text", async (name) => {
      const granter = role(testSnowflake(), {
        name,
        permissions: ADMINISTRATOR_BIT,
      });
      const { dependencies, edits } = world(
        {},
        { roles: [...ROLE_LIST, granter] },
      );

      await run(
        ROUTER,
        setupPayload({
          treasury_role: role(CHOSEN.treasury_role.id, { name }),
        }),
        dependencies,
      );

      const content = edits[0]?.content ?? "";
      expect(content).not.toMatch(/(?<!\\)@everyone/);
      expect(content).not.toMatch(/(?<!\\)<@&/);
      expect(content).not.toMatch(/(?<!\\)\[click/);
      expect(content).not.toMatch(/(?<!\\)\*\*bold/);
      expect(content).not.toMatch(/\n#/);
      expect(content).not.toContain("‮");
      expect(content).not.toContain("​");
      expect(content).not.toMatch(/(?<!\\)discord\.gg/);
    });

    it("never pings or unfurls", async () => {
      const { dependencies, edits } = world();

      await run(
        ROUTER,
        setupPayload({
          eboard_role: role(CHOSEN.eboard_role.id, { name: "@everyone" }),
        }),
        dependencies,
      );

      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    });

    it("shows a placeholder for a name with nothing visible", async () => {
      const { dependencies, edits } = world();

      await run(
        ROUTER,
        setupPayload({
          marketing_role: role(CHOSEN.marketing_role.id, {
            name: "​‮",
          }),
        }),
        dependencies,
      );

      expect(edits[0]?.content).toContain(
        "Marketing Committee: (no visible name)",
      );
      expect(edits[0]?.components).toHaveLength(1);
    });

    it("stays within a message's limit with the longest names and many granters", async () => {
      const long = "*".repeat(100);
      const granters = Array.from({ length: 30 }, () =>
        role(testSnowflake(), { name: long, permissions: ADMINISTRATOR_BIT }),
      );
      const { dependencies, edits } = world({}, { roles: granters });
      const longNames = Object.fromEntries(
        SETUP_OPTIONS.map((name) => [
          name,
          role(CHOSEN[name].id, { name: long }),
        ]),
      );

      await run(ROUTER, setupPayload(longNames), dependencies);

      expect(edits[0]?.components).toHaveLength(1);
      expect(edits[0]?.content).toContain("and more");
      expect(edits[0]?.content.length).toBeLessThanOrEqual(2000);
    });
  });

  it("ignores options it does not ask for, so nothing forges the audit actor", async () => {
    const w = world();
    const forged = testSnowflake();
    const { dependencies, edits, rpcBodies } = w;

    await run(
      ROUTER,
      setupPayload({}, {}, [
        { name: "p_actor_id", type: 3, value: forged },
        { name: "p_guild_id", type: 3, value: forged },
        { name: "guildId", type: 3, value: forged },
      ]),
      dependencies,
    );
    await run(
      ROUTER,
      componentPayload(firstCustomId(edits[0]), { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(rpcBodies("save_setup_draft")).toEqual([
      expect.objectContaining({ p_guild_id: GUILD_ID, p_actor_id: MEMBER_ID }),
    ]);
    expect(rpcBodies("apply_role_bindings")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 0,
        p_actor_id: MEMBER_ID,
        ...CHOSEN_BINDINGS,
      },
    ]);
  });

  it("says who could grant the roles, and that it could not check when the lookup fails", async () => {
    const manager = role(testSnowflake(), {
      name: "Mods",
      permissions: MANAGE_ROLES_BIT,
      position: 9,
    });
    const { dependencies, edits } = world(
      {},
      { roles: [...ROLE_LIST, manager] },
    );
    const failing = world({}, { roles: "fail" });

    await run(ROUTER, setupPayload(), dependencies);
    await run(ROUTER, setupPayload(), failing.dependencies);

    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant these: Mods. The server owner may also be able to.",
    );
    expect(failing.edits[0]?.content).toContain("could not check");
    expect(failing.edits[0]?.components).toHaveLength(1);
    expect(JSON.stringify(failing.edits)).not.toContain("canary");
  });
});

describe("rolesThatMayGrant", () => {
  it.each([
    ["Administrator below", ADMINISTRATOR_BIT, 1, true],
    ["Administrator above", ADMINISTRATOR_BIT, 9, true],
    ["Manage Roles above", MANAGE_ROLES_BIT, 6, true],
    ["Manage Roles below", MANAGE_ROLES_BIT, 4, true],
    ["neither", 1n << 10n, 9, false],
  ])("%s", (_label, permissions, position, expected) => {
    expect(
      rolesThatMayGrant([role(testSnowflake(), { permissions, position })]),
    ).toHaveLength(expected ? 1 : 0);
  });

  it("includes the chosen role itself, and lists the highest first", () => {
    const low = role(CHOSEN.events_directors_role.id, {
      permissions: MANAGE_ROLES_BIT,
      position: 2,
    });
    const high = role(testSnowflake(), {
      permissions: ADMINISTRATOR_BIT,
      position: 8,
    });

    expect(rolesThatMayGrant([low, high])).toEqual([high, low]);
  });

  it("does not round high bits into Manage Roles", () => {
    expect(
      rolesThatMayGrant([
        role(testSnowflake(), { permissions: (1n << 54n) | 7n, position: 9 }),
      ]),
    ).toEqual([]);
  });
});

describe("Confirm", () => {
  const confirmId = (version = 0, fingerprint = FINGERPRINT) =>
    `setup.confirm:${String(version)}:${fingerprint}`;

  it("saves the five roles from the draft this member was shown, with E-board as admin", async () => {
    const w = world();
    const { dependencies, edits, rpcBodies, state } = w;

    await run(ROUTER, componentPayload(await showSetup(w)), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 0,
        p_actor_id: MEMBER_ID,
        ...CHOSEN_BINDINGS,
      },
    ]);
    expect(state.config).toMatchObject({
      officer_role_id: CHOSEN.events_directors_role.id,
      admin_role_id: CHOSEN.eboard_role.id,
      eboard_role_id: CHOSEN.eboard_role.id,
      events_committee_role_id: CHOSEN.events_committee_role.id,
      treasury_role_id: CHOSEN.treasury_role.id,
      marketing_role_id: CHOSEN.marketing_role.id,
    });
    expect(edits[1]?.content).toContain("Saved.");
    for (const name of SETUP_OPTIONS) {
      expect(edits[1]?.content).toContain(
        `${SHOWN[name]}: ${CHOSEN[name].name}`,
      );
    }
    expect(edits[1]?.components).toEqual([]);
  });

  it("replaces every saved role, including ones chosen before", async () => {
    const w = world({
      config: configRow({
        version: 3,
        eboard_role_id: testSnowflake(),
        treasury_role_id: testSnowflake(),
      }),
    });

    await run(ROUTER, componentPayload(await showSetup(w)), w.dependencies);

    expect(w.state.config?.eboard_role_id).toBe(CHOSEN.eboard_role.id);
    expect(w.state.config?.treasury_role_id).toBe(CHOSEN.treasury_role.id);
  });

  it.each([
    ["a plain member", PLAIN_MEMBER],
    ["an officer", OFFICER],
    ["the bound admin role", ADMIN],
    ["a former administrator", member()],
  ])("refuses %s, even with a copied button", async (_label, who) => {
    const w = world({ config: configRow() });
    const customId = await showSetup(w);
    const { dependencies, rpcBodies, edits } = w;

    const { reply } = await run(
      ROUTER,
      componentPayload(customId, { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(edits).toHaveLength(1);
  });

  it("refuses a Confirm on a message that is not private", async () => {
    const w = world();

    const { reply } = await run(
      ROUTER,
      componentPayload(await showSetup(w), { message: { flags: 0 } }),
      w.dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
  });

  it("gives a replayed Confirm no second write", async () => {
    const w = world();
    const payload = componentPayload(await showSetup(w));

    await run(ROUTER, payload, w.dependencies);
    await run(ROUTER, payload, w.dependencies);

    expect(w.rpcBodies("apply_role_bindings")).toHaveLength(1);
    expect(w.edits).toHaveLength(2);
  });

  describe("a draft that does not match", () => {
    it("refuses a fingerprint that is not the draft's", async () => {
      const w = world();
      await showSetup(w);

      await run(
        ROUTER,
        componentPayload(confirmId(0, "0123456789abcdef")),
        w.dependencies,
      );

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[1]?.content).toContain(NO_DRAFT_TEXT);
      expect(w.edits[1]?.content).toContain("Nothing was changed");
      expect(w.edits[1]?.components).toEqual([]);
    });

    it("refuses an earlier Confirm once /setup was run again with other roles", async () => {
      const w = world();
      const first = await showSetup(w);
      await showSetup(w, ADMINISTRATOR, {
        treasury_role: CHOSEN.marketing_role,
        marketing_role: CHOSEN.treasury_role,
      });

      await run(ROUTER, componentPayload(first), w.dependencies);

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[2]?.content).toContain(NO_DRAFT_TEXT);
    });

    it("refuses a draft older than an hour", async () => {
      const w = world();
      const customId = await showSetup(w);
      for (const draft of w.state.drafts) {
        draft.created_at = new Date(Date.now() - 3_600_001).toISOString();
      }

      await run(ROUTER, componentPayload(customId), w.dependencies);

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[1]?.content).toContain(NO_DRAFT_TEXT);
    });

    it("refuses another administrator's draft, even with the same button", async () => {
      const w = world();
      const customId = await showSetup(w);
      const other = member({
        id: testSnowflake(),
        permissions: ADMINISTRATOR_PERMISSIONS,
      });

      await run(
        ROUTER,
        componentPayload(customId, { member: other }),
        w.dependencies,
      );

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[1]?.content).toContain(NO_DRAFT_TEXT);
    });

    it("refuses when no draft was ever saved", async () => {
      const w = world();

      await run(ROUTER, componentPayload(confirmId()), w.dependencies);

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[0]?.content).toContain(NO_DRAFT_TEXT);
    });

    it("says try again, with no database text, when the draft can't be read", async () => {
      const w = world();
      const customId = await showSetup(w);
      w.state.failing = { path: "setup_drafts", status: 503 };

      await run(ROUTER, componentPayload(customId), w.dependencies);

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(w.edits[1]?.content).toContain("Something went wrong");
      expect(JSON.stringify(w.edits)).not.toContain("canary");
    });
  });

  it("refuses with a refresh message when someone saved first", async () => {
    const w = world({ config: configRow({ version: 3 }) });
    const customId = await showSetup(w);
    w.state.config = configRow({ version: 4 });

    await run(ROUTER, componentPayload(customId), w.dependencies);

    expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
    expect(w.edits[1]?.content).toContain("Someone else changed the roles");
    expect(w.edits[1]?.components).toEqual([]);
  });

  it("refuses a stale version before reading the draft", async () => {
    const w = world({ config: configRow({ version: 4 }) });

    await run(ROUTER, componentPayload(confirmId(3)), w.dependencies);

    expect(w.edits[0]?.content).toContain("Someone else changed the roles");
    expect(w.requests.some((r) => r.target.includes("setup_drafts"))).toBe(
      false,
    );
  });

  it("refuses with the same refresh message when the database says stale", async () => {
    const w = world({ config: configRow({ version: 3 }) });
    const customId = await showSetup(w);
    w.state.failing = {
      path: "apply_role_bindings",
      status: 400,
      code: "CF409",
    };

    await run(ROUTER, componentPayload(customId), w.dependencies);

    expect(w.edits[1]?.content).toContain("Someone else changed the roles");
    expect(JSON.stringify(w.edits)).not.toContain("canary");
  });

  it("lets exactly one of two racing clicks win", async () => {
    const w = world({ config: configRow({ version: 3 }) });
    const customId = await showSetup(w);

    await Promise.all([
      run(ROUTER, componentPayload(customId), w.dependencies),
      run(ROUTER, componentPayload(customId), w.dependencies),
    ]);

    expect(w.state.config?.version).toBe(4);
    const texts = w.edits.slice(1).map((edit) => edit.content);
    expect(texts.filter((text) => text.includes("Saved."))).toHaveLength(1);
    expect(
      texts.filter((text) => text.includes("Someone else changed the roles")),
    ).toHaveLength(1);
    expect(w.rpcBodies("claim_interaction")).toHaveLength(2);
  });

  it.each(SETUP_OPTIONS)(
    "refuses when the %s was deleted since the panel opened",
    async (name) => {
      const w = world();
      const customId = await showSetup(w);
      const { discord, edits } = fakeDiscord({
        roles: ROLE_LIST.filter((item) => item.id !== CHOSEN[name].id),
      });

      await run(
        ROUTER,
        componentPayload(customId),
        dependenciesFor(w.db, discord),
      );

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(edits[0]?.content).toContain(
        `The ${LABELS[name]} role could not be found, so nothing was changed.`,
      );
      expect(edits[0]?.components).toEqual([]);
    },
  );

  it.each(SETUP_OPTIONS)(
    "refuses when the %s became managed since the panel opened",
    async (name) => {
      const w = world();
      const customId = await showSetup(w);
      const { discord, edits } = fakeDiscord({
        roles: ROLE_LIST.map((item) =>
          item.id === CHOSEN[name].id ? { ...item, managed: true } : item,
        ),
      });

      await run(
        ROUTER,
        componentPayload(customId),
        dependenciesFor(w.db, discord),
      );

      expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
      expect(edits[0]?.content).toContain(
        `The ${LABELS[name]} role can't be ${CHOSEN[name].name}, because an integration controls who holds it.`,
      );
    },
  );

  it("refuses @everyone in a stored draft", async () => {
    const roles = { ...setupRolesOf(CHOSEN), treasuryRoleId: GUILD_ID };
    const fingerprint = setupDraftFingerprint(roles);
    const w = world({
      drafts: [
        {
          guild_id: GUILD_ID,
          actor_id: MEMBER_ID,
          officer_role_id: roles.officerRoleId,
          admin_role_id: roles.adminRoleId,
          eboard_role_id: roles.eboardRoleId,
          events_committee_role_id: roles.eventsCommitteeRoleId,
          treasury_role_id: roles.treasuryRoleId,
          marketing_role_id: roles.marketingRoleId,
          fingerprint,
          created_at: new Date().toISOString(),
        },
      ],
    });

    await run(
      ROUTER,
      componentPayload(confirmId(0, fingerprint)),
      w.dependencies,
    );

    expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
    expect(w.edits[0]?.content).toContain(
      "The Treasury Committee role can't be \\@everyone",
    );
  });

  it("refuses to save when Discord can't confirm the roles", async () => {
    const w = world();
    const customId = await showSetup(w);
    const { discord, edits } = fakeDiscord({ roles: "fail" });

    await run(
      ROUTER,
      componentPayload(customId),
      dependenciesFor(w.db, discord),
    );

    expect(w.rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("nothing was changed");
    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it.each([
    ["an extra separator", `setup.confirm:0:${FINGERPRINT}:1`],
    [
      "the old form with role IDs",
      `setup.confirm:0:${testSnowflake()}:${testSnowflake()}`,
    ],
    ["a fingerprint that is not hex", "setup.confirm:0:ABCDEFGHIJKLMNOP"],
    ["a short fingerprint", `setup.confirm:0:${FINGERPRINT.slice(1)}`],
    ["authority in the ID", `setup.confirm:0:${FINGERPRINT}:admin`],
    ["a missing version", `setup.confirm:${FINGERPRINT}`],
  ])("refuses %s", async (_label, customId) => {
    const { dependencies, rpcBodies } = world();

    const { reply } = await run(
      ROUTER,
      componentPayload(customId),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(rpcBodies("apply_role_bindings")).toEqual([]);
  });

  it("says try again, with no database text, when the save fails", async () => {
    const w = world();
    const customId = await showSetup(w);
    w.state.failing = { path: "apply_role_bindings", status: 503 };

    await run(ROUTER, componentPayload(customId), w.dependencies);

    expect(w.edits[1]?.content).toContain("Something went wrong");
    expect(JSON.stringify(w.edits)).not.toContain("canary");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
  });

  it("shows no nickname anywhere, whatever the payload holds", async () => {
    const { dependencies, edits } = world();
    const hostile = "canary-nick";

    await run(
      ROUTER,
      setupPayload(
        {},
        {
          member: {
            ...ADMINISTRATOR,
            nick: hostile,
            user: {
              id: MEMBER_ID,
              username: hostile,
              global_name: hostile,
            },
          },
        },
      ),
      dependencies,
    );

    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it("leaves the existing bindings in place after a refusal", async () => {
    const w = world({ config: configRow({ version: 9 }) });

    await run(ROUTER, componentPayload(confirmId(3)), w.dependencies);

    expect(w.state.config?.officer_role_id).toBe(OFFICER_ROLE);
    expect(w.state.config?.admin_role_id).toBe(ADMIN_ROLE);
  });
});
