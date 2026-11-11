import { hash } from "node:crypto";
import { isUsableTimeZone } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { and, desc, eq, gt, sql as fragment } from "drizzle-orm";
import {
  CONFIG_CHANGE_COLUMNS,
  GUILD_CONFIG_COLUMNS,
  SETUP_DRAFT_COLUMNS,
} from "./columns.ts";
import { callFunction, run } from "./internal.ts";
import { configAudit, guildConfig, setupDrafts } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import {
  booleanValue,
  cappedList,
  integerValue,
  oneOrNone,
  type CappedList,
} from "./result.ts";
import {
  parseConfigChange,
  parseGuildConfig,
  parseSetupDraft,
  type ConfigChange,
  type GuildConfig,
  type SetupDraft,
} from "./types.ts";
import {
  MAX_TIMEZONE_LENGTH,
  isInstant,
  isSnowflakeList,
  isStoredText,
  isVersion,
} from "./validate.ts";

/** The most a Discord select menu can submit, and the most the function accepts. */
const MAX_CHANNELS_PER_CHANGE = 25;
const RECENT_CHANGES = 5;

export async function getGuildConfig(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<GuildConfig | null>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(GUILD_CONFIG_COLUMNS)
        .from(guildConfig)
        .where(eq(guildConfig.guildId, guildId))
        .limit(1),
    ),
    parseGuildConfig,
  );
}

/** The six roles /setup chooses. `officerRoleId` is the role shown as Events Directors. */
export interface SetupRoles {
  officerRoleId: string;
  adminRoleId: string;
  eboardRoleId: string;
  eventsCommitteeRoleId: string;
  treasuryRoleId: string;
  marketingRoleId: string;
}

export interface RoleBindings {
  guildId: string;
  actorId: string;
  expectedVersion: number;
  /** Shown as Events Directors. */
  officerRoleId: string;
  adminRoleId: string;
  /** Null leaves the role unbound. */
  eboardRoleId: string | null;
  eventsCommitteeRoleId: string | null;
  treasuryRoleId: string | null;
  marketingRoleId: string | null;
}

/** A Discord ID that is not the guild's @everyone role, whose ID is the guild's own. */
function isBindableRole(roleId: unknown, guildId: string): boolean {
  return isSnowflake(roleId) && roleId !== guildId;
}

/**
 * Returns the new config version. A stale version fails as `stale_version`. Every role is
 * written: a null one is stored as unbound, not left as it was.
 */
export async function applyRoleBindings(
  db: DbClient,
  {
    guildId,
    actorId,
    expectedVersion,
    officerRoleId,
    adminRoleId,
    eboardRoleId,
    eventsCommitteeRoleId,
    treasuryRoleId,
    marketingRoleId,
  }: RoleBindings,
): Promise<DbResult<number>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    !isVersion(expectedVersion) ||
    !isBindableRole(officerRoleId, guildId) ||
    !isBindableRole(adminRoleId, guildId) ||
    ![
      eboardRoleId,
      eventsCommitteeRoleId,
      treasuryRoleId,
      marketingRoleId,
    ].every((roleId) => roleId === null || isBindableRole(roleId, guildId))
  ) {
    return refused();
  }
  return integerValue(
    await callFunction(
      db,
      fragment`public.apply_role_bindings(p_guild_id => ${guildId}, p_expected_version => ${expectedVersion}, p_actor_id => ${actorId}, p_officer_role_id => ${officerRoleId}, p_admin_role_id => ${adminRoleId}, p_eboard_role_id => ${eboardRoleId}, p_events_committee_role_id => ${eventsCommitteeRoleId}, p_treasury_role_id => ${treasuryRoleId}, p_marketing_role_id => ${marketingRoleId})`,
    ),
  );
}

/** How long a /setup draft stays usable. Older ones read as absent. */
export const SETUP_DRAFT_TTL_MS = 3_600_000;

const FINGERPRINT = /^[0-9a-f]{16}$/;

/**
 * A short, fixed-length digest of the six roles in a fixed order, for a Confirm
 * custom_id to carry. A click whose fingerprint differs from the stored draft's was
 * shown other roles than the draft now holds.
 */
export function setupDraftFingerprint(roles: SetupRoles): string {
  const ids = [
    roles.officerRoleId,
    roles.adminRoleId,
    roles.eboardRoleId,
    roles.eventsCommitteeRoleId,
    roles.treasuryRoleId,
    roles.marketingRoleId,
  ];
  // Hex, so it fits the router's fingerprint field.
  return hash("sha256", ids.join(":"), "hex").slice(0, 16);
}

function isSetupRoles(roles: SetupRoles, guildId: string): boolean {
  return [
    roles.officerRoleId,
    roles.adminRoleId,
    roles.eboardRoleId,
    roles.eventsCommitteeRoleId,
    roles.treasuryRoleId,
    roles.marketingRoleId,
  ].every((roleId) => isBindableRole(roleId, guildId));
}

/**
 * Stores what /setup showed, replacing the guild's earlier draft. The fingerprint is
 * worked out here from the roles, so a draft and its fingerprint always agree.
 * Returns the fingerprint for the Confirm button.
 */
export async function saveSetupDraft(
  db: DbClient,
  {
    guildId,
    actorId,
    roles,
  }: { guildId: string; actorId: string; roles: SetupRoles },
): Promise<DbResult<string>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    !isSetupRoles(roles, guildId)
  ) {
    return refused();
  }
  const fingerprint = setupDraftFingerprint(roles);
  const saved = booleanValue(
    await callFunction(
      db,
      fragment`public.save_setup_draft(p_guild_id => ${guildId}, p_actor_id => ${actorId}, p_officer_role_id => ${roles.officerRoleId}, p_admin_role_id => ${roles.adminRoleId}, p_eboard_role_id => ${roles.eboardRoleId}, p_events_committee_role_id => ${roles.eventsCommitteeRoleId}, p_treasury_role_id => ${roles.treasuryRoleId}, p_marketing_role_id => ${roles.marketingRoleId}, p_fingerprint => ${fingerprint})`,
    ),
  );
  return saved.ok ? { ok: true, value: fingerprint } : saved;
}

/**
 * The guild's draft from the last hour, or null. Pass the fingerprint the click carried:
 * a draft with another fingerprint, or one saved by another member, also reads as null,
 * so a stale button can never apply roles it did not show.
 */
export async function getSetupDraft(
  db: DbClient,
  {
    guildId,
    actorId,
    fingerprint,
    now,
  }: { guildId: string; actorId: string; fingerprint: string; now: Date },
): Promise<DbResult<SetupDraft | null>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    typeof fingerprint !== "string" ||
    !FINGERPRINT.test(fingerprint) ||
    !isInstant(now)
  ) {
    return refused();
  }
  const draft = oneOrNone(
    await run(db, (sql) =>
      sql
        .select(SETUP_DRAFT_COLUMNS)
        .from(setupDrafts)
        .where(
          and(
            eq(setupDrafts.guildId, guildId),
            eq(setupDrafts.actorId, actorId),
            eq(setupDrafts.fingerprint, fingerprint),
            gt(
              setupDrafts.createdAt,
              new Date(now.getTime() - SETUP_DRAFT_TTL_MS).toISOString(),
            ),
          ),
        )
        .limit(1),
    ),
    parseSetupDraft,
  );
  if (!draft.ok || draft.value === null) {
    return draft;
  }
  // The fingerprint is stored as given, so check it still matches the roles beside it.
  return setupDraftFingerprint(draftRoles(draft.value)) ===
    draft.value.fingerprint
    ? draft
    : { ok: true, value: null };
}

/** The roles of a draft, in the shape `applyRoleBindings` takes. */
export function draftRoles(draft: SetupDraft): SetupRoles {
  return {
    officerRoleId: draft.officer_role_id,
    adminRoleId: draft.admin_role_id,
    eboardRoleId: draft.eboard_role_id,
    eventsCommitteeRoleId: draft.events_committee_role_id,
    treasuryRoleId: draft.treasury_role_id,
    marketingRoleId: draft.marketing_role_id,
  };
}

export interface ConfigChangeInput {
  guildId: string;
  actorId: string;
  expectedVersion: number;
  /** Null leaves the setting alone. */
  remindersEnabled: boolean | null;
  addChannelIds: readonly string[];
  removeChannelIds: readonly string[];
  /** Null leaves the setting alone. The database checks that the zone exists. */
  timezone: string | null;
}

/** Returns the new config version. A stale version fails as `stale_version`. */
export async function applyConfigChange(
  db: DbClient,
  {
    guildId,
    actorId,
    expectedVersion,
    remindersEnabled,
    addChannelIds,
    removeChannelIds,
    timezone,
  }: ConfigChangeInput,
): Promise<DbResult<number>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    !isVersion(expectedVersion) ||
    !isSnowflakeList(addChannelIds, MAX_CHANNELS_PER_CHANGE) ||
    !isSnowflakeList(removeChannelIds, MAX_CHANNELS_PER_CHANGE) ||
    !(
      timezone === null ||
      (isStoredText(timezone, MAX_TIMEZONE_LENGTH) &&
        isUsableTimeZone(timezone))
    )
  ) {
    return refused();
  }
  return integerValue(
    await callFunction(
      db,
      fragment`public.apply_config_change(p_guild_id => ${guildId}, p_expected_version => ${expectedVersion}, p_actor_id => ${actorId}, p_reminders_enabled => ${remindersEnabled}, p_add_channel_ids => ${fragment.param([...addChannelIds])}::text[]::text[], p_remove_channel_ids => ${fragment.param([...removeChannelIds])}::text[]::text[], p_timezone => ${timezone})`,
    ),
  );
}

/** The latest changes for the config panel, newest first. */
export async function listRecentConfigChanges(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ConfigChange>>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(CONFIG_CHANGE_COLUMNS)
        .from(configAudit)
        .where(eq(configAudit.guildId, guildId))
        .orderBy(desc(configAudit.id))
        .limit(RECENT_CHANGES + 1),
    ),
    parseConfigChange,
    RECENT_CHANGES,
  );
}
