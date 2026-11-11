/**
 * The per-event workflow: Budget Sheet, Engage post, Budget approved and Food pickup, the
 * people on each, the one-time ping that follows a finished step, and the claim cycle of
 * the event reminders. Every write is a database function, which locks the step, checks
 * the event and enforces the limits, so nothing here can be raced past.
 *
 * A write on an event that is unknown, in another guild or deleted fails as `not_found`,
 * and on a closed event as `parent_unavailable`. Who may make a write is decided before
 * calling it: these functions check only that the rows allow it.
 */

import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import { rest } from "./internal.ts";
import {
  booleanValue,
  cappedList,
  nullableUuidValue,
  rowList,
  type ApiResponse,
  type CappedList,
  type RowList,
} from "./result.ts";
import {
  ASSIGNABLE_STEP_KINDS,
  COMPLETABLE_STEP_KINDS,
  EVENT_REMINDER_KINDS,
  parseEventReminderCandidate,
  parseEventReminderStaleClaim,
  parseEventWorkflow,
  parseUserStep,
  type AssignableStepKind,
  type CompletableStepKind,
  type EventReminderCandidate,
  type EventReminderKind,
  type EventReminderStaleClaim,
  type EventWorkflow,
  type UserStep,
} from "./types.ts";
import {
  MAX_ID_LIST,
  isDbDate,
  isInstant,
  isPickupTime,
  isUuid,
  uuidList,
} from "./validate.ts";

/** Enforced by assign_event_step: see the event workflow migration. */
export const MAX_ASSIGNEES_PER_STEP = 10;
/** Enforced by assign_event_step, for Food pickup alone. */
export const MAX_FOOD_PICKUP_ASSIGNEES = 15;

const MAX_USER_STEPS = 100;
const MAX_REMINDER_EVENTS = 500;
const MAX_STALE_CLAIMS = 500;

export interface EventStepKey {
  guildId: string;
  eventId: string;
}

function isEventStepKey({ guildId, eventId }: EventStepKey): boolean {
  return isSnowflake(guildId) && isUuid(eventId);
}

function isAssignable(kind: unknown): kind is AssignableStepKind {
  return ASSIGNABLE_STEP_KINDS.some((candidate) => candidate === kind);
}

function isCompletable(kind: unknown): kind is CompletableStepKind {
  return COMPLETABLE_STEP_KINDS.some((candidate) => candidate === kind);
}

/** The step functions return null when there is no live event with that ID in that guild. */
function liveEventBoolean(response: ApiResponse): DbResult<boolean> {
  if (response.error === null && response.data === null) {
    return failure("not_found");
  }
  return booleanValue(response);
}

/**
 * The steps and live assignments of each live event named, in this guild. An event that
 * is unknown, deleted or another guild's is left out. At most `MAX_ID_LIST` IDs.
 */
export async function listEventWorkflows(
  db: DbClient,
  { guildId, eventIds }: { guildId: string; eventIds: readonly string[] },
): Promise<DbResult<RowList<EventWorkflow>>> {
  if (
    !isSnowflake(guildId) ||
    !Array.isArray(eventIds) ||
    eventIds.length > MAX_ID_LIST ||
    !eventIds.every(isUuid)
  ) {
    return refused();
  }
  if (eventIds.length === 0) {
    return { ok: true, value: { rows: [], excluded: [] } };
  }
  return rowList(
    await rest(db)
      .from("events")
      .select(
        "id,pickup_time,event_steps(event_id,kind,status,completed_at,completed_by,handoff_claimed_at,handoff_sent_at),event_step_assignees(id,event_id,kind,user_id,assigned_by,created_at)",
      )
      .eq("guild_id", guildId)
      .in("id", uuidList(eventIds))
      .is("deleted_at", null)
      .is("event_step_assignees.removed_at", null)
      .order("id")
      .limit(MAX_ID_LIST),
    parseEventWorkflow,
  );
}

/** One live event's steps and live assignments, or null if there is no such event. */
export async function getEventWorkflow(
  db: DbClient,
  key: EventStepKey,
): Promise<DbResult<EventWorkflow | null>> {
  if (!isEventStepKey(key)) {
    return refused();
  }
  const list = await listEventWorkflows(db, {
    guildId: key.guildId,
    eventIds: [key.eventId],
  });
  if (!list.ok) {
    return list;
  }
  const { rows, excluded } = list.value;
  if (excluded.length > 0 || rows.length > 1) {
    return failure("bad_row");
  }
  return { ok: true, value: rows[0] ?? null };
}

export interface StepAssignment extends EventStepKey {
  kind: AssignableStepKind;
  userId: string;
  actorId: string;
}

function isStepAssignment(input: StepAssignment): boolean {
  return (
    isEventStepKey(input) &&
    isAssignable(input.kind) &&
    isSnowflake(input.userId) &&
    isSnowflake(input.actorId)
  );
}

/**
 * Puts a member on Budget Sheet, Engage post or Food pickup. True if this call added them,
 * false if they were on it already. Fails as `step_assignee_limit` once the step has
 * `MAX_ASSIGNEES_PER_STEP` people (`MAX_FOOD_PICKUP_ASSIGNEES` for Food pickup), and Food
 * pickup fails as `step_not_ready` until the budget is approved.
 */
export async function assignEventStep(
  db: DbClient,
  input: StepAssignment,
): Promise<DbResult<boolean>> {
  if (!isStepAssignment(input)) {
    return refused();
  }
  return liveEventBoolean(
    await rest(db).rpc("assign_event_step", {
      p_event_id: input.eventId,
      p_guild_id: input.guildId,
      p_kind: input.kind,
      p_user_id: input.userId,
      p_actor_id: input.actorId,
    }),
  );
}

/**
 * Takes a member off a step. The assignment is kept, marked removed. True if this call
 * removed them, false if they were not on it. Taking the last person off Food pickup
 * reopens it.
 */
export async function unassignEventStep(
  db: DbClient,
  input: StepAssignment,
): Promise<DbResult<boolean>> {
  if (!isStepAssignment(input)) {
    return refused();
  }
  return liveEventBoolean(
    await rest(db).rpc("unassign_event_step", {
      p_event_id: input.eventId,
      p_guild_id: input.guildId,
      p_kind: input.kind,
      p_user_id: input.userId,
      p_actor_id: input.actorId,
    }),
  );
}

/**
 * Marks Budget Sheet, Engage post or Budget approved done. True if this call did it, and
 * only then should the caller go on to `claimStepHandoff`. False if it was done already.
 */
export async function completeEventStep(
  db: DbClient,
  input: EventStepKey & { kind: CompletableStepKind; actorId: string },
): Promise<DbResult<boolean>> {
  if (
    !isEventStepKey(input) ||
    !isCompletable(input.kind) ||
    !isSnowflake(input.actorId)
  ) {
    return refused();
  }
  return liveEventBoolean(
    await rest(db).rpc("complete_event_step", {
      p_event_id: input.eventId,
      p_guild_id: input.guildId,
      p_kind: input.kind,
      p_actor_id: input.actorId,
    }),
  );
}

export type HandoffKey = EventStepKey & { kind: CompletableStepKind };

function isHandoffKey(key: HandoffKey): boolean {
  return isEventStepKey(key) && isCompletable(key.kind);
}

/**
 * The right to send the message that follows a finished step. True for exactly one caller
 * per step, ever, so the role is pinged at most once. A caller that then fails to send
 * leaves the ping unsent for good. False if the step is not done, the hand-off is taken,
 * or the event is not live.
 */
export async function claimStepHandoff(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  if (!isHandoffKey(key)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("claim_step_handoff", {
      p_event_id: key.eventId,
      p_guild_id: key.guildId,
      p_kind: key.kind,
    }),
  );
}

/** For after the claimed hand-off went out. False if it was not claimed or is recorded. */
export async function markStepHandoffSent(
  db: DbClient,
  key: HandoffKey,
): Promise<DbResult<boolean>> {
  if (!isHandoffKey(key)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_step_handoff_sent", {
      p_event_id: key.eventId,
      p_guild_id: key.guildId,
      p_kind: key.kind,
    }),
  );
}

/**
 * Sets the pickup time, as `HH:MM` on a 24-hour clock, local to the guild on the event's
 * date. Fails as `step_not_ready` until the budget is approved. Returns whether Food pickup
 * is now done, which also needs at least one person on it.
 */
export async function setEventPickupTime(
  db: DbClient,
  input: EventStepKey & { pickupTime: string; actorId: string },
): Promise<DbResult<boolean>> {
  if (
    !isEventStepKey(input) ||
    !isPickupTime(input.pickupTime) ||
    !isSnowflake(input.actorId)
  ) {
    return refused();
  }
  return liveEventBoolean(
    await rest(db).rpc("set_event_pickup_time", {
      p_event_id: input.eventId,
      p_guild_id: input.guildId,
      p_pickup_time: input.pickupTime,
      p_actor_id: input.actorId,
    }),
  );
}

const KIND_ORDER: readonly AssignableStepKind[] = ASSIGNABLE_STEP_KINDS;

/**
 * For /mytasks: a member's open Budget Sheet and Engage post steps, and their Food pickups
 * from `today` on, on live active events in one guild. Soonest event first.
 */
export async function listOpenStepsForUser(
  db: DbClient,
  {
    guildId,
    userId,
    today,
  }: { guildId: string; userId: string; today: DateOnly },
): Promise<DbResult<CappedList<UserStep>>> {
  if (!isSnowflake(guildId) || !isSnowflake(userId) || !isDbDate(today)) {
    return refused();
  }
  const list = cappedList(
    await rest(db)
      .from("event_step_assignees")
      .select(
        "id,kind,events!inner(id,name,event_date,pickup_time,event_steps(kind,status))",
      )
      .eq("guild_id", guildId)
      .eq("user_id", userId)
      .is("removed_at", null)
      .eq("events.status", "active")
      .is("events.deleted_at", null)
      .order("created_at")
      .order("id")
      .limit(MAX_USER_STEPS + 1),
    parseUserStep,
    MAX_USER_STEPS,
  );
  if (!list.ok) {
    return list;
  }
  const rows = list.value.rows
    .flatMap((step) =>
      (
        step.kind === "food_pickup"
          ? step.event_date >= today
          : step.step_status === "open"
      )
        ? [step]
        : [],
    )
    .sort((a, b) =>
      a.event_date === b.event_date
        ? KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
          a.event_id.localeCompare(b.event_id)
        : a.event_date < b.event_date
          ? -1
          : 1,
    );
  return { ok: true, value: { ...list.value, rows } };
}

/**
 * Every live active event dated `fromDate` or later, across all guilds, whose channel is
 * active and whose guild has reminders on, with its steps, live assignments and the log
 * rows dated `fromDate` or later. Pass a date early enough for every timezone, such as
 * yesterday in UTC, and decide per guild which events are due. Soonest first.
 */
export async function listEventReminderCandidates(
  db: DbClient,
  { fromDate }: { fromDate: DateOnly },
): Promise<DbResult<CappedList<EventReminderCandidate>>> {
  if (!isDbDate(fromDate)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,name,event_date,thread_id,thread_status,created_by,thread_refusals,pickup_time,managed_channels!inner(guild_config!inner(timezone,officer_role_id)),event_steps(kind,status),event_step_assignees(id,kind,user_id,created_at),event_reminder_log(kind,reminder_date,state,claimed_at)",
      )
      .eq("status", "active")
      .is("deleted_at", null)
      .gte("event_date", fromDate)
      .eq("managed_channels.status", "active")
      .is("managed_channels.guild_config.reminders_enabled", true)
      .is("event_step_assignees.removed_at", null)
      .gte("event_reminder_log.reminder_date", fromDate)
      .order("event_date")
      .order("id")
      .limit(MAX_REMINDER_EVENTS + 1),
    parseEventReminderCandidate,
    MAX_REMINDER_EVENTS,
  );
}

/** Event reminder claims left unfinished since before the cutoff, oldest first. */
export async function listStaleEventReminderClaims(
  db: DbClient,
  { claimedBefore }: { claimedBefore: Date },
): Promise<DbResult<CappedList<EventReminderStaleClaim>>> {
  if (!isInstant(claimedBefore)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("event_reminder_log")
      .select("event_id,kind,reminder_date,claim_token,attempts,claimed_at")
      .eq("state", "claimed")
      .lt("claimed_at", claimedBefore.toISOString())
      .order("claimed_at")
      .order("event_id")
      .order("kind")
      .order("reminder_date")
      .limit(MAX_STALE_CLAIMS + 1),
    parseEventReminderStaleClaim,
    MAX_STALE_CLAIMS,
  );
}

/**
 * One event reminder. `reminderDate` is the local date the message is for: the day itself
 * for `daily_steps`, two days before the event for `pickup_two_days`, and the event's date
 * for `pickup_day`. The claim refuses any other date.
 */
export interface EventReminderKey {
  eventId: string;
  kind: EventReminderKind;
  reminderDate: DateOnly;
}

function isEventReminderKey({
  eventId,
  kind,
  reminderDate,
}: EventReminderKey): boolean {
  return (
    isUuid(eventId) &&
    EVENT_REMINDER_KINDS.some((candidate) => candidate === kind) &&
    isDbDate(reminderDate)
  );
}

/**
 * Returns a claim token, or null if someone else holds it, or the reminder is not due:
 * the event is not live and active, its channel or the guild's reminders are off, the date
 * does not suit the kind, or a pickup reminder's Food pickup is not set up.
 */
export async function claimEventReminder(
  db: DbClient,
  key: EventReminderKey,
): Promise<DbResult<string | null>> {
  if (!isEventReminderKey(key)) {
    return refused();
  }
  return nullableUuidValue(
    await rest(db).rpc("claim_event_reminder", {
      p_event_id: key.eventId,
      p_kind: key.kind,
      p_reminder_date: key.reminderDate,
    }),
  );
}

/** Takes over a claim over an hour old given its last token. Null if that is not possible. */
export async function reclaimEventReminder(
  db: DbClient,
  key: EventReminderKey & { claimToken: string },
): Promise<DbResult<string | null>> {
  if (!isEventReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return nullableUuidValue(
    await rest(db).rpc("reclaim_event_reminder", {
      p_event_id: key.eventId,
      p_kind: key.kind,
      p_reminder_date: key.reminderDate,
      p_claim_token: key.claimToken,
    }),
  );
}

/** False if the token no longer holds the claim. */
export async function markEventReminderSent(
  db: DbClient,
  key: EventReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (
    !isEventReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isSnowflake(key.messageId)
  ) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_event_reminder_sent", {
      p_event_id: key.eventId,
      p_kind: key.kind,
      p_reminder_date: key.reminderDate,
      p_claim_token: key.claimToken,
      p_message_id: key.messageId,
    }),
  );
}

/** For a claimed reminder deliberately not sent. False if the token no longer holds it. */
export async function markEventReminderSkipped(
  db: DbClient,
  key: EventReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isEventReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_event_reminder_skipped", {
      p_event_id: key.eventId,
      p_kind: key.kind,
      p_reminder_date: key.reminderDate,
      p_claim_token: key.claimToken,
    }),
  );
}
