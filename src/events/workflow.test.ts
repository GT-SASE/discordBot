import { describe, expect, it } from "vitest";
import { hasLiveSyntax } from "../../test/support/hostile-text.ts";
import { testSnowflake } from "../../test/support/mock-db.ts";
import { channelMessage } from "../discord/outbound.ts";
import { safeTextValue } from "../discord/safe-text.ts";
import { handoffMessage } from "./workflow.ts";

const GUILD = testSnowflake();
const TREASURY = testSnowflake();
const MARKETING = testSnowflake();
const CREATOR = testSnowflake();
const EVENT = { name: "Fall Social", created_by: CREATOR };
const CONFIG = {
  guild_id: GUILD,
  treasury_role_id: TREASURY,
  marketing_role_id: MARKETING,
};

function sent(input: ReturnType<typeof handoffMessage>) {
  return channelMessage(input).payload as {
    content: string;
    allowed_mentions: unknown;
  };
}

describe("handoffMessage", () => {
  it("pings only the Treasury role when Budget Sheet is done", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "budget_sheet"))).toMatchObject({
      content: `<@&${TREASURY}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY] },
    });
  });

  it("pings only the Marketing role when the Engage post is up", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "engage_post"))).toMatchObject({
      content: `<@&${MARKETING}> Engage post for **Fall Social** is up.`,
      allowed_mentions: { parse: [], users: [], roles: [MARKETING] },
    });
  });

  it("pings only the creator when the budget is approved", () => {
    expect(
      sent(handoffMessage(CONFIG, EVENT, "budget_approved")),
    ).toMatchObject({
      content: `<@${CREATOR}> The budget for **Fall Social** is approved. Set up food pickup with /event pickup and /event assign step:Food pickup.`,
      allowed_mentions: { parse: [], users: [CREATOR] },
    });
  });

  it.each([
    ["budget_sheet", "Treasury Committee", { treasury_role_id: null }],
    ["engage_post", "Marketing Committee", { marketing_role_id: null }],
    ["budget_sheet", "Treasury Committee", { treasury_role_id: GUILD }],
  ] as const)(
    "pings nobody for %s and says to choose the %s role when it is unset",
    (kind, role, unset) => {
      const body = sent(handoffMessage({ ...CONFIG, ...unset }, EVENT, kind));

      expect(body.content).toContain(`Run /setup to choose the ${role} role`);
      expect(body.content).not.toContain("<@&");
      expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
    },
  );

  it("keeps a hostile event name inert", () => {
    const input = handoffMessage(
      CONFIG,
      { ...EVENT, name: "@everyone <@&1> **x**" },
      "budget_sheet",
    );

    const content = safeTextValue(input.content);
    const name = content.slice(content.indexOf("**") + 2, -" is done.".length);

    expect(hasLiveSyntax(name.slice(0, -2))).toBe(false);
    expect(input.mentionRoleIds).toEqual([TREASURY]);
  });
});
