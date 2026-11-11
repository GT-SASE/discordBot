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
import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql as fragment,
} from "drizzle-orm";
import { selected } from "./columns.ts";
import { callFunction, run } from "./internal.ts";
import {
  eventReminderLog,
  eventStepAssignees,
  eventSteps,
  events,
  guildConfig,
  managedChannels,
} from "./schema.ts";
import {
  booleanValue,
  cappedList,
  nullableUuidValue,
  oneOrNone,
  rowList,
  type CappedList,
  type RowList,
} from "./result.ts";
import {
  ASSIGNABLE_STEP_KINDS,
  COMPLETABLE_STEP_KINDS,
  EVENT_REMINDER_KINDS,
  parseEventClaimLiveness,
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

/** Enforced by assign_event_step: see db/migrations/0001_baseline.sql. */
export const MAX_ASSIGNEES_PER_STEP = 10;
/** Enforced by assign_event_step, for Food pickup alone. */
export const MAX_FOOD_PICKUP_ASSIGNEES = 15;

const MAX_USER_STEPS = 100;

/** An event's four steps, as a JSON array of the named fields. */
const STEPS_OF_EVENT = fragment<unknown>`coalesce((
  SELECT json_agg(json_build_object(
    'event_id', ${eventSteps.eventId},
    'kind', ${eventSteps.kind},
    'status', ${eventSteps.status},
    'completed_at', ${eventSteps.completedAt},
    'completed_by', ${eventSteps.completedBy},
    'handoff_claimed_at', ${eventSteps.handoffClaimedAt},
    'handoff_sent_at', ${eventSteps.handoffSentAt}))
  FROM ${eventSteps}
  WHERE ${eventSteps.eventId} = ${events.id} AND ${eventSteps.guildId} = ${events.guildId}
), '[]'::json)`;

/** The kind and status of each of an event's steps, as a JSON array. */
const STEP_STATUSES_OF_EVENT = fragment<unknown>`coalesce((
  SELECT json_agg(json_build_object('kind', ${eventSteps.kind}, 'status', ${eventSteps.status}))
  FROM ${eventSteps}
  WHERE ${eventSteps.eventId} = ${events.id} AND ${eventSteps.guildId} = ${events.guildId}
), '[]'::json)`;

/** An event's live assignments, as a JSON array of the named fields. */
const LIVE_ASSIGNEES_OF_EVENT = fragment<unknown>`coalesce((
  SELECT json_agg(json_build_object(
    'id', ${eventStepAssignees.id},
    'event_id', ${eventStepAssignees.eventId},
    'kind', ${eventStepAssignees.kind},
    'user_id', ${eventStepAssignees.userId},
    'assigned_by', ${eventStepAssignees.assignedBy},
    'created_at', ${eventStepAssignees.createdAt}))
  FROM ${eventStepAssignees}
  WHERE ${eventStepAssignees.eventId} = ${events.id}
    AND ${eventStepAssignees.guildId} = ${events.guildId}
    AND ${eventStepAssignees.removedAt} IS NULL
), '[]'::json)`;
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
function liveEventBoolean(result: DbResult<unknown>): DbResult<boolean> {
  if (result.ok && result.value === null) {
    return failure("not_found");
  }
  return booleanValue(result);
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
    await run(db, (sql) =>
      sql
        .select({
          id: events.id,
          pickup_time: events.pickupTime,
          event_steps: selected(STEPS_OF_EVENT),
          event_step_assignees: selected(LIVE_ASSIGNEES_OF_EVENT),
        })
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            inArray(events.id, uuidList(eventIds)),
            isNull(events.deletedAt),
          ),
        )
        .orderBy(asc(events.id))
        .limit(MAX_ID_LIST),
    ),
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
    await callFunction(
      db,
      fragment`public.assign_event_step(p_event_id => ${input.eventId}, p_guild_id => ${input.guildId}, p_kind => ${input.kind}, p_user_id => ${input.userId}, p_actor_id => ${input.actorId})`,
    ),
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
    await callFunction(
      db,
      fragment`public.unassign_event_step(p_event_id => ${input.eventId}, p_guild_id => ${input.guildId}, p_kind => ${input.kind}, p_user_id => ${input.userId}, p_actor_id => ${input.actorId})`,
    ),
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
    await callFunction(
      db,
      fragment`public.complete_event_step(p_event_id => ${input.eventId}, p_guild_id => ${input.guildId}, p_kind => ${input.kind}, p_actor_id => ${input.actorId})`,
    ),
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
    await callFunction(
      db,
      fragment`public.claim_step_handoff(p_event_id => ${key.eventId}, p_guild_id => ${key.guildId}, p_kind => ${key.kind})`,
    ),
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
    await callFunction(
      db,
      fragment`public.mark_step_handoff_sent(p_event_id => ${key.eventId}, p_guild_id => ${key.guildId}, p_kind => ${key.kind})`,
    ),
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
    await callFunction(
      db,
      fragment`public.set_event_pickup_time(p_event_id => ${input.eventId}, p_guild_id => ${input.guildId}, p_pickup_time => ${input.pickupTime}, p_actor_id => ${input.actorId})`,
    ),
  );
}

const KIND_ORDER: readonly AssignableStepKind[] = ASSIGNABLE_STEP_KINDS;

/**
 * For /mytasks: a member's open Budget Sheet and Engage post steps, and their Food pickups
 * from `today` on, on live active events in one guild. Events from `today` on come first,
 * soonest first, then the open steps of events already past, most recent first.
 *
 * Done steps and past pickups are left out by the query, and the cap keeps the events from
 * `today` on before any that are past, so a member with many old assignments still sees
 * what is coming up.
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
    await run(db, (sql) =>
      sql
        .select({
          id: eventStepAssignees.id,
          kind: eventStepAssignees.kind,
          events: {
            id: events.id,
            name: events.name,
            event_date: events.eventDate,
            pickup_time: events.pickupTime,
            event_steps: selected(STEP_STATUSES_OF_EVENT),
          },
        })
        .from(eventStepAssignees)
        .innerJoin(
          events,
          and(
            eq(events.id, eventStepAssignees.eventId),
            eq(events.guildId, eventStepAssignees.guildId),
          ),
        )
        .where(
          and(
            eq(eventStepAssignees.guildId, guildId),
            eq(eventStepAssignees.userId, userId),
            isNull(eventStepAssignees.removedAt),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            or(
              and(
                eq(eventStepAssignees.kind, "food_pickup"),
                gte(events.eventDate, today),
              ),
              and(
                ne(eventStepAssignees.kind, "food_pickup"),
                exists(
                  sql
                    .select({ kind: eventSteps.kind })
                    .from(eventSteps)
                    .where(
                      and(
                        eq(eventSteps.eventId, events.id),
                        eq(eventSteps.guildId, events.guildId),
                        eq(eventSteps.kind, eventStepAssignees.kind),
                        eq(eventSteps.status, "open"),
                      ),
                    ),
                ),
              ),
            ),
          ),
        )
        .orderBy(
          asc(lt(events.eventDate, today)),
          asc(fragment`abs(${events.eventDate} - ${today}::date)`),
          asc(eventStepAssignees.kind),
          asc(events.id),
          asc(eventStepAssignees.id),
        )
        .limit(MAX_USER_STEPS + 1),
    ),
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
    .sort((a, b) => {
      const aPast = a.event_date < today;
      const bPast = b.event_date < today;
      if (aPast !== bPast) {
        return aPast ? 1 : -1;
      }
      if (a.event_date !== b.event_date) {
        // Upcoming soonest first, and past ones most recent first, as the cap keeps them.
        return a.event_date < b.event_date === aPast ? 1 : -1;
      }
      return (
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.event_id.localeCompare(b.event_id)
      );
    });
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
    await run(db, (sql) =>
      sql
        .select({
          id: events.id,
          guild_id: events.guildId,
          name: events.name,
          event_date: events.eventDate,
          thread_id: events.threadId,
          thread_status: events.threadStatus,
          created_by: events.createdBy,
          thread_refusals: events.threadRefusals,
          pickup_time: events.pickupTime,
          managed_channels: selected(fragment<unknown>`json_build_object(
            'guild_config', json_build_object(
              'timezone', ${guildConfig.timezone},
              'officer_role_id', ${guildConfig.officerRoleId}))`),
          event_steps: selected(STEP_STATUSES_OF_EVENT),
          event_step_assignees: selected(fragment<unknown>`coalesce((
            SELECT json_agg(json_build_object(
              'id', ${eventStepAssignees.id},
              'kind', ${eventStepAssignees.kind},
              'user_id', ${eventStepAssignees.userId},
              'created_at', ${eventStepAssignees.createdAt}))
            FROM ${eventStepAssignees}
            WHERE ${eventStepAssignees.eventId} = ${events.id}
              AND ${eventStepAssignees.guildId} = ${events.guildId}
              AND ${eventStepAssignees.removedAt} IS NULL
          ), '[]'::json)`),
          event_reminder_log: selected(fragment<unknown>`coalesce((
            SELECT json_agg(json_build_object(
              'kind', ${eventReminderLog.kind},
              'reminder_date', ${eventReminderLog.reminderDate},
              'state', ${eventReminderLog.state},
              'claimed_at', ${eventReminderLog.claimedAt}))
            FROM ${eventReminderLog}
            WHERE ${eventReminderLog.eventId} = ${events.id}
              AND ${eventReminderLog.reminderDate} >= ${fromDate}
          ), '[]'::json)`),
        })
        .from(events)
        .innerJoin(
          managedChannels,
          and(
            eq(managedChannels.guildId, events.guildId),
            eq(managedChannels.channelId, events.channelId),
          ),
        )
        .innerJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
        .where(
          and(
            eq(events.status, "active"),
            isNull(events.deletedAt),
            gte(events.eventDate, fromDate),
            eq(managedChannels.status, "active"),
            eq(guildConfig.remindersEnabled, true),
          ),
        )
        .orderBy(asc(events.eventDate), asc(events.id))
        .limit(MAX_REMINDER_EVENTS + 1),
    ),
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
    await run(db, (sql) =>
      sql
        .select({
          event_id: eventReminderLog.eventId,
          kind: eventReminderLog.kind,
          reminder_date: eventReminderLog.reminderDate,
          claim_token: eventReminderLog.claimToken,
          attempts: eventReminderLog.attempts,
          claimed_at: eventReminderLog.claimedAt,
        })
        .from(eventReminderLog)
        .where(
          and(
            eq(eventReminderLog.state, "claimed"),
            lt(eventReminderLog.claimedAt, claimedBefore.toISOString()),
          ),
        )
        .orderBy(
          asc(eventReminderLog.claimedAt),
          asc(eventReminderLog.eventId),
          asc(eventReminderLog.kind),
          asc(eventReminderLog.reminderDate),
        )
        .limit(MAX_STALE_CLAIMS + 1),
    ),
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
    await callFunction(
      db,
      fragment`public.claim_event_reminder(p_event_id => ${key.eventId}, p_kind => ${key.kind}, p_reminder_date => ${key.reminderDate})`,
    ),
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
    await callFunction(
      db,
      fragment`public.reclaim_event_reminder(p_event_id => ${key.eventId}, p_kind => ${key.kind}, p_reminder_date => ${key.reminderDate}, p_claim_token => ${key.claimToken})`,
    ),
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
    await callFunction(
      db,
      fragment`public.mark_event_reminder_sent(p_event_id => ${key.eventId}, p_kind => ${key.kind}, p_reminder_date => ${key.reminderDate}, p_claim_token => ${key.claimToken}, p_message_id => ${key.messageId})`,
    ),
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
    await callFunction(
      db,
      fragment`public.mark_event_reminder_skipped(p_event_id => ${key.eventId}, p_kind => ${key.kind}, p_reminder_date => ${key.reminderDate}, p_claim_token => ${key.claimToken})`,
    ),
  );
}

/**
 * Closes a stale event reminder claim that no plan named, once its event is read again
 * and shows it can never go out: the event is gone, deleted or closed, its post is gone,
 * or it was dated before `beforeDate`, a day already past in every guild. Anything else
 * is left exactly as it is, with no takeover and no rise in `attempts`: a guild with
 * reminders off, whatever its events, and a live event the candidate read left out, such
 * as one in a forum no longer managed, which may be added back, or one whose row failed
 * its checks. "closed" only when this call recorded it skipped.
 */
export async function closeStaleEventClaim(
  db: DbClient,
  key: EventReminderKey & { claimToken: string; beforeDate: DateOnly },
): Promise<DbResult<"closed" | "left">> {
  if (
    !isEventReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isDbDate(key.beforeDate)
  ) {
    return refused();
  }
  const read = oneOrNone(
    await run(db, (sql) =>
      sql
        .select({
          state: eventReminderLog.state,
          claim_token: eventReminderLog.claimToken,
          event_status: events.status,
          event_deleted_at: events.deletedAt,
          event_date: events.eventDate,
          thread_status: events.threadStatus,
          reminders_enabled: guildConfig.remindersEnabled,
        })
        .from(eventReminderLog)
        .leftJoin(events, eq(events.id, eventReminderLog.eventId))
        .leftJoin(guildConfig, eq(guildConfig.guildId, events.guildId))
        .where(
          and(
            eq(eventReminderLog.eventId, key.eventId),
            eq(eventReminderLog.kind, key.kind),
            eq(eventReminderLog.reminderDate, key.reminderDate),
          ),
        )
        .limit(1),
    ),
    parseEventClaimLiveness,
  );
  if (!read.ok) {
    return read;
  }
  const live = read.value;
  if (
    live?.state !== "claimed" ||
    live.claim_token !== key.claimToken ||
    // Paused for now: closing would keep it from going out once they are back on.
    live.reminders_enabled === false
  ) {
    return { ok: true, value: "left" };
  }
  const dead =
    live.event_status !== "active" ||
    live.event_deleted_at !== null ||
    live.thread_status === "missing" ||
    live.event_date === null ||
    live.event_date < key.beforeDate;
  if (!dead) {
    return { ok: true, value: "left" };
  }
  const marked = await markEventReminderSkipped(db, key);
  if (!marked.ok) {
    return marked;
  }
  return { ok: true, value: marked.value ? "closed" : "left" };
}
