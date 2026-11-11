/**
 * Builds interactions the way the endpoint receives them, and runs them through a
 * router with no network: the database answers from memory and Discord is a fake.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  InteractionType,
} from "discord-api-types/v10";
import type {
  DiscordClient,
  GuildChannel,
  GuildRole,
} from "../../src/discord/client.ts";
import {
  isAllowedGuildInteraction,
  type GuildInteraction,
} from "../../src/discord/interactions.ts";
import {
  verifiedInteractionFrom,
  verifySignedRequest,
  type VerifiedInteraction,
} from "../../src/discord/verify.ts";
import type { Router, RouterDependencies } from "../../src/handlers/router.ts";
import type { DbClient } from "../../src/db/client.ts";
import { mockDb, testSnowflake, type RecordedRequest } from "./mock-db.ts";
import {
  asSelected,
  comparisons,
  limitOf,
  sqlTarget,
  type SqlCall,
} from "./sql-client.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const SIGNED_AT = "1700000000";

export const GUILD_ID = testSnowflake();
export const APP_ID = testSnowflake();
export const MEMBER_ID = testSnowflake();
export const OFFICER_ROLE = testSnowflake();
export const ADMIN_ROLE = testSnowflake();
export const ADMINISTRATOR_BIT = String(1n << 3n);
const EPHEMERAL_FLAG = 64;

export interface MemberFields {
  readonly id?: string;
  readonly roles?: readonly string[];
  readonly permissions?: string;
}

export function member({
  id = MEMBER_ID,
  roles = [],
  permissions = "0",
}: MemberFields = {}): Record<string, unknown> {
  return { user: { id }, roles, permissions };
}

export const ADMINISTRATOR = member({ permissions: ADMINISTRATOR_BIT });
export const ADMIN = member({ roles: [ADMIN_ROLE] });
export const OFFICER = member({ roles: [OFFICER_ROLE] });
export const PLAIN_MEMBER = member();

function base(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: testSnowflake(),
    token: "test-interaction-token",
    application_id: APP_ID,
    guild_id: GUILD_ID,
    channel: { id: testSnowflake(), type: 0 },
    context: InteractionContextType.Guild,
    authorizing_integration_owners: { "0": GUILD_ID },
    member: ADMINISTRATOR,
    ...fields,
  };
}

export function commandPayload(
  name: string,
  fields: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ApplicationCommand,
    data: { type: ApplicationCommandType.ChatInput, name, ...data },
    ...fields,
  });
}

export function componentPayload(
  customId: unknown,
  fields: Record<string, unknown> = {},
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.MessageComponent,
    message: { id: testSnowflake(), flags: EPHEMERAL_FLAG },
    data: { custom_id: customId, component_type: 2, ...data },
    ...fields,
  });
}

export function modalPayload(
  customId: unknown,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ModalSubmit,
    data: { custom_id: customId },
    ...fields,
  });
}

export function autocompletePayload(
  name: string,
  typed: unknown,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return base({
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      type: ApplicationCommandType.ChatInput,
      name,
      options: [{ name: "event", type: 3, value: typed, focused: true }],
    },
    ...fields,
  });
}

/** The /setup options, in the order the command asks for them. */
export const SETUP_OPTIONS = [
  "eboard_role",
  "events_directors_role",
  "events_committee_role",
  "treasury_role",
  "marketing_role",
] as const;

export type SetupOption = (typeof SETUP_OPTIONS)[number];

/** A /setup command choosing these roles, each also given in `resolved` as Discord does. */
export function setupCommandPayload(
  roles: Record<SetupOption, GuildRole>,
  fields: Record<string, unknown> = {},
  extraOptions: unknown[] = [],
): Record<string, unknown> {
  return commandPayload("setup", fields, {
    options: [
      ...SETUP_OPTIONS.map((name) => ({
        name,
        type: ApplicationCommandOptionType.Role,
        value: roles[name].id,
      })),
      ...extraOptions,
    ],
    resolved: {
      roles: Object.fromEntries(
        SETUP_OPTIONS.map((name) => [
          roles[name].id,
          { ...roles[name], permissions: String(roles[name].permissions) },
        ]),
      ),
    },
  });
}

/** The custom_id on the first button of a reply, such as /setup's Confirm. */
export function firstCustomId(
  edit: { components?: unknown[] } | undefined,
): string {
  const [row] = (edit?.components ?? []) as {
    components: { custom_id: string }[];
  }[];
  return row?.components[0]?.custom_id ?? "";
}

/** Passes the real signature check, which is the only way to get these two values. */
export function verify(payload: unknown): {
  interaction: GuildInteraction;
  verified: VerifiedInteraction;
} {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SIGNED_AT), body]),
    privateKey,
  ).toString("hex");
  const signed = verifySignedRequest(
    { body, signature, timestamp: SIGNED_AT },
    PUBLIC_KEY_HEX,
    Number(SIGNED_AT) * 1000,
  );
  const interaction = signed?.payload;
  const verified = signed && verifiedInteractionFrom(signed);
  if (
    verified === undefined ||
    !isAllowedGuildInteraction(interaction, {
      applicationId: APP_ID,
      allowedGuildIds: new Set([GUILD_ID]),
    })
  ) {
    throw new Error("Test payload was not accepted");
  }
  return { interaction, verified };
}

export interface ConfigRow {
  guild_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string | null;
  events_committee_role_id: string | null;
  treasury_role_id: string | null;
  marketing_role_id: string | null;
  timezone: string;
  reminders_enabled: boolean;
  version: number;
}

export function configRow(fields: Partial<ConfigRow> = {}): ConfigRow {
  return {
    guild_id: GUILD_ID,
    officer_role_id: OFFICER_ROLE,
    admin_role_id: ADMIN_ROLE,
    eboard_role_id: null,
    events_committee_role_id: null,
    treasury_role_id: null,
    marketing_role_id: null,
    timezone: "America/New_York",
    reminders_enabled: true,
    version: 3,
    ...fields,
  };
}

interface ChannelRow {
  guild_id: string;
  channel_id: string;
  status: "active" | "unavailable" | "removed";
}

export function managedRow(
  channelId: string,
  status: ChannelRow["status"] = "active",
): ChannelRow {
  return { guild_id: GUILD_ID, channel_id: channelId, status };
}

export interface ChangeRow {
  id: number;
  actor_id: string;
  action: string;
  old_values: unknown;
  new_values: unknown;
  version_after: number;
  created_at: string;
}

export interface DraftRow {
  guild_id: string;
  actor_id: string;
  officer_role_id: string;
  admin_role_id: string;
  eboard_role_id: string;
  events_committee_role_id: string;
  treasury_role_id: string;
  marketing_role_id: string;
  fingerprint: string;
  created_at: string;
}

export interface DbState {
  config: ConfigRow | null;
  /** /setup drafts, one per guild as in the database. */
  drafts: DraftRow[];
  channels: ChannelRow[];
  changes: ChangeRow[];
  /** Task rows for the open-task count, by channel. */
  openTasks: Map<string, number>;
  claimed: Set<string>;
  /** Event rows, for what reads them by channel or ID. */
  events?: Record<string, unknown>[];
  /**
   * Fails a statement whose path holds this text, with this Postgres error code, or
   * XX000 if none is given. A statement built with Drizzle has the path
   * `select <table>` or `call <function>`.
   */
  failing?: { path: string; code?: string };
}

const STALE = { error: "CF409" };

/** An in-memory stand-in with the version rules of the real database functions. */
export function fakeDb(fields: Partial<DbState> = {}): {
  db: DbClient;
  state: DbState;
  requests: RecordedRequest[];
  rpcBodies: (name: string) => Record<string, unknown>[];
} {
  const state: DbState = {
    config: null,
    drafts: [],
    channels: [],
    changes: [],
    openTasks: new Map(),
    claimed: new Set(),
    ...fields,
  };

  function roleBindings(args: Record<string, unknown>) {
    const current = state.config?.version ?? 0;
    if (args.p_expected_version !== current) {
      return STALE;
    }
    state.config = configRow({
      officer_role_id: args.p_officer_role_id as string,
      admin_role_id: args.p_admin_role_id as string,
      eboard_role_id: args.p_eboard_role_id as string | null,
      events_committee_role_id: args.p_events_committee_role_id as
        string | null,
      treasury_role_id: args.p_treasury_role_id as string | null,
      marketing_role_id: args.p_marketing_role_id as string | null,
      version: current + 1,
    });
    return { value: current + 1 };
  }

  function saveDraft(args: Record<string, unknown>) {
    const row: DraftRow = {
      guild_id: args.p_guild_id as string,
      actor_id: args.p_actor_id as string,
      officer_role_id: args.p_officer_role_id as string,
      admin_role_id: args.p_admin_role_id as string,
      eboard_role_id: args.p_eboard_role_id as string,
      events_committee_role_id: args.p_events_committee_role_id as string,
      treasury_role_id: args.p_treasury_role_id as string,
      marketing_role_id: args.p_marketing_role_id as string,
      fingerprint: args.p_fingerprint as string,
      created_at: new Date().toISOString(),
    };
    state.drafts = [
      ...state.drafts.filter((draft) => draft.guild_id !== row.guild_id),
      row,
    ];
    return { value: true };
  }

  function configChange(args: Record<string, unknown>) {
    if (
      state.config === null ||
      args.p_expected_version !== state.config.version
    ) {
      return STALE;
    }
    for (const id of args.p_remove_channel_ids as string[]) {
      const row = state.channels.find(
        (channel) => channel.channel_id === id && channel.status !== "removed",
      );
      if (row === undefined) {
        return { error: "22023" };
      }
      row.status = "removed";
    }
    for (const id of args.p_add_channel_ids as string[]) {
      const row = state.channels.find((channel) => channel.channel_id === id);
      if (row === undefined) {
        state.channels.push(managedRow(id));
      } else {
        row.status = "active";
      }
    }
    if (typeof args.p_reminders_enabled === "boolean") {
      state.config.reminders_enabled = args.p_reminders_enabled;
    }
    state.config.version += 1;
    return { value: state.config.version };
  }

  /** Rows that pass every `column = $n` and `created_at > $n` the statement holds. */
  function matching(
    call: SqlCall,
    rows: readonly Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const filters = comparisons(call);
    const limit = limitOf(call);
    return rows
      .map((row) => ({ ...row }))
      .filter((row) =>
        [...filters].every(([key, value]) => {
          const [column = "", operator] = key.split(" ");
          if (!(column in row)) {
            return true;
          }
          return operator === ">"
            ? Date.parse(String(row[column])) > Date.parse(String(value))
            : operator === "="
              ? row[column] === value
              : true;
        }),
      )
      .slice(0, limit);
  }

  /** Answers the reads src/db builds with Drizzle, from the same state. */
  function read(call: SqlCall) {
    const [, table] = sqlTarget(call.sql).split(" ");
    const answer = (rows: readonly object[]) => ({
      rows: asSelected(
        call.sql,
        matching(call, rows as readonly Record<string, unknown>[]),
      ),
    });
    switch (table) {
      case "guild_config":
        return answer(state.config === null ? [] : [state.config]);
      case "managed_channels":
        return answer(state.channels);
      case "setup_drafts":
        return answer(state.drafts);
      case "config_audit":
        return answer(state.changes);
      case "events":
        return answer(state.events ?? []);
      case "tasks": {
        const channel = comparisons(call).get("channel_id =");
        const count = state.openTasks.get(String(channel)) ?? 0;
        return {
          rows: Array.from({ length: count }, (_, index) => [
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          ]),
        };
      }
      default:
        return { error: "XX000" };
    }
  }

  const { db, requests } = mockDb((request) => {
    const path = sqlTarget(request.target);
    if (state.failing !== undefined && path.includes(state.failing.path)) {
      return { error: state.failing.code ?? "XX000" };
    }
    const fn = path.startsWith("call ") ? path.slice("call ".length) : null;
    if (fn === null) {
      return read({
        sql: request.target,
        params: request.values as unknown[],
      });
    }
    const args = (request.values ?? {}) as Record<string, unknown>;
    if (fn === "claim_interaction") {
      const id = args.p_interaction_id as string;
      const first = !state.claimed.has(id);
      state.claimed.add(id);
      return { value: first };
    }
    if (fn === "apply_role_bindings") {
      return roleBindings(args);
    }
    if (fn === "save_setup_draft") {
      return saveDraft(args);
    }
    if (fn === "apply_config_change") {
      return configChange(args);
    }
    return { error: "XX000" };
  });

  return {
    db,
    state,
    requests,
    rpcBodies: (name) =>
      requests
        .filter((request) => sqlTarget(request.target) === `call ${name}`)
        .map((request) => request.values as Record<string, unknown>),
  };
}

export interface FakeDiscordData {
  roles?: readonly GuildRole[] | "fail";
  channels?: readonly GuildChannel[] | "fail";
  botRoleIds?: readonly string[] | "fail";
}

function orFail<T>(value: T | "fail"): Promise<T> {
  return value === "fail"
    ? Promise.reject(new Error("canary discord failure"))
    : Promise.resolve(value);
}

/** Records edits to the original reply, and refuses every way of posting elsewhere. */
export function fakeDiscord(data: FakeDiscordData = {}): {
  discord: DiscordClient;
  edits: { content: string; components?: unknown[]; flags: number }[];
} {
  const edits: { content: string; components?: unknown[]; flags: number }[] =
    [];
  const refuse = () =>
    Promise.reject(new Error("This route must not post to a channel"));
  const discord: DiscordClient = {
    getChannel: refuse,
    sendMessage: refuse,
    editMessage: refuse,
    reopenThread: refuse,
    createThread: refuse,
    replyToInteraction: refuse,
    editInteractionReply: refuse,
    sendFollowUp: refuse,
    respondEphemerally: refuse,
    editEphemeralReply: (_interaction, body) => {
      edits.push(body.payload as (typeof edits)[number]);
      return Promise.resolve({ id: testSnowflake() });
    },
    getGuildRoles: () => orFail(data.roles ?? []),
    getGuildChannels: () => orFail(data.channels ?? []),
    getGuildChannel: (_guildId, channelId) =>
      orFail(data.channels ?? []).then((channels) => {
        const found = channels.find((channel) => channel.id === channelId);
        return found ?? Promise.reject(new Error("canary discord failure"));
      }),
    getGuildMemberRoleIds: () => orFail(data.botRoleIds ?? []),
    describeChannel: () => Promise.reject(new Error("canary discord failure")),
    listActiveThreads: () =>
      Promise.reject(new Error("canary discord failure")),
    listArchivedThreads: () =>
      Promise.reject(new Error("canary discord failure")),
  };
  return { discord, edits };
}

export function dependenciesFor(
  db: DbClient,
  discord: DiscordClient,
): RouterDependencies {
  return { db: () => db, finishDb: () => db, discord: () => discord };
}

export interface Ran {
  /** What the endpoint would answer over HTTP. */
  reply: { type: number; data?: Record<string, unknown> };
  deferred: boolean;
}

/** Runs one interaction to the end, including the work done after the reply. */
export async function run(
  router: Router,
  payload: unknown,
  dependencies: RouterDependencies,
): Promise<Ran> {
  const { interaction, verified } = verify(payload);
  const outcome = await router.handle(interaction, verified, dependencies);
  await outcome.after?.();
  return {
    reply: outcome.reply.payload as Ran["reply"],
    deferred: outcome.after !== undefined,
  };
}
