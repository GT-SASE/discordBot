import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import { REMINDER_KINDS } from "../reminders/plan.ts";
import type { DbClient } from "./client.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  and,
  asc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  or,
  sql as fragment,
} from "drizzle-orm";
import { selected } from "./columns.ts";
import { callFunction, run } from "./internal.ts";
import {
  events,
  guildConfig,
  managedChannels,
  reminderLog,
  tasks,
} from "./schema.ts";
import {
  booleanValue,
  cappedList,
  integerValue,
  nullableUuidValue,
  oneOrNone,
  rowList,
  type CappedList,
} from "./result.ts";
import {
  parseCandidateCursor,
  parseClaimState,
  parseReminderCandidate,
  parseStaleClaim,
  parseTaskLiveness,
  type ExcludedRow,
  type ReminderCandidate,
  type ReminderKind,
  type StaleClaim,
} from "./types.ts";
import { isDbDate, isInstant, isUuid } from "./validate.ts";

const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const MAX_STALE_CLAIMS = 500;
/** Sorts before every row: the earliest date the column allows, and the lowest ID. */
const FIRST_POSITION = {
  dueDate: "2000-01-01",
  id: "00000000-0000-0000-0000-000000000000",
};

/**
 * Open tasks due up to a date, across all guilds, with every condition that can stop
 * a send: the task, its event, its channel and the guild's reminder switch. These are
 * filters on `!inner` joins, so a parent that fails one removes the task.
 *
 * A filter here cannot compare a log row's date with its task's date, so each task
 * carries its whole log and the planner decides what has already gone out.
 *
 * Pages follow `due_date, id`, so a row changed during the read cannot shift a later
 * page. `truncated` means rows remain unread. They are the latest due, and the next
 * run reaches them only once earlier tasks have left this list, so log it when set.
 */
export async function listReminderCandidates(
  db: DbClient,
  { lastDueDate }: { lastDueDate: DateOnly },
): Promise<DbResult<CappedList<ReminderCandidate>>> {
  if (!isDbDate(lastDueDate)) {
    return refused();
  }
  const rows: ReminderCandidate[] = [];
  const excluded: ExcludedRow[] = [];
  let position = FIRST_POSITION;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { dueDate, id } = position;
    const response = await run(db, (sql) =>
      sql
        .select({
          id: tasks.id,
          event_id: tasks.eventId,
          guild_id: tasks.guildId,
          assignee_id: tasks.assigneeId,
          description: tasks.description,
          due_date: tasks.dueDate,
          status: tasks.status,
          updated_at: tasks.updatedAt,
          events: {
            id: events.id,
            name: events.name,
            thread_id: events.threadId,
            status: events.status,
            thread_status: events.threadStatus,
            thread_refusals: events.threadRefusals,
            managed_channels: selected(fragment<unknown>`json_build_object(
              'guild_config', json_build_object('timezone', ${guildConfig.timezone}))`),
          },
          reminder_log: selected(fragment<unknown>`coalesce((
            SELECT json_agg(json_build_object(
              'kind', ${reminderLog.kind},
              'due_date', ${reminderLog.dueDate},
              'state', ${reminderLog.state},
              'claimed_at', ${reminderLog.claimedAt}))
            FROM ${reminderLog}
            WHERE ${reminderLog.taskId} = ${tasks.id}), '[]'::json)`),
        })
        .from(tasks)
        .innerJoin(
          events,
          and(eq(events.id, tasks.eventId), eq(events.guildId, tasks.guildId)),
        )
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
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
            lte(tasks.dueDate, lastDueDate),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            eq(managedChannels.status, "active"),
            eq(guildConfig.remindersEnabled, true),
            // Rows after the last one read, in due_date, id order.
            or(
              gt(tasks.dueDate, dueDate),
              and(eq(tasks.dueDate, dueDate), gt(tasks.id, id)),
            ),
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.id))
        .limit(PAGE_SIZE),
    );
    const list = rowList(response, parseReminderCandidate);
    if (!list.ok) {
      return list;
    }
    rows.push(...list.value.rows);
    excluded.push(...list.value.excluded);
    const count = list.value.rows.length + list.value.excluded.length;
    if (count < PAGE_SIZE) {
      return { ok: true, value: { rows, excluded, truncated: false } };
    }
    const last = parseCandidateCursor(
      response.ok ? response.value.at(-1) : undefined,
    );
    if (!last.ok) {
      // A row with no readable position leaves nowhere to continue from.
      return { ok: true, value: { rows, excluded, truncated: true } };
    }
    position = last.row;
  }
  return { ok: true, value: { rows, excluded, truncated: true } };
}

/** Claims left unfinished since before the cutoff, oldest first. */
export async function listStaleClaims(
  db: DbClient,
  { claimedBefore }: { claimedBefore: Date },
): Promise<DbResult<CappedList<StaleClaim>>> {
  if (!isInstant(claimedBefore)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select({
          task_id: reminderLog.taskId,
          kind: reminderLog.kind,
          due_date: reminderLog.dueDate,
          claim_token: reminderLog.claimToken,
          attempts: reminderLog.attempts,
          refused_attempts: reminderLog.refusedAttempts,
          claimed_at: reminderLog.claimedAt,
        })
        .from(reminderLog)
        .where(
          and(
            eq(reminderLog.state, "claimed"),
            lt(reminderLog.claimedAt, claimedBefore.toISOString()),
          ),
        )
        .orderBy(
          asc(reminderLog.claimedAt),
          asc(reminderLog.taskId),
          asc(reminderLog.kind),
          asc(reminderLog.dueDate),
        )
        .limit(MAX_STALE_CLAIMS + 1),
    ),
    parseStaleClaim,
    MAX_STALE_CLAIMS,
  );
}

export interface ReminderKey {
  taskId: string;
  kind: ReminderKind;
  dueDate: DateOnly;
}

function isReminderKey({ taskId, kind, dueDate }: ReminderKey): boolean {
  return isUuid(taskId) && REMINDER_KINDS.includes(kind) && isDbDate(dueDate);
}

/**
 * The task as a caller read it. A claim that names this fails as `task_changed` if the
 * task has since been reassigned or edited, because what the caller rendered is out of date.
 */
export interface TaskAsRead {
  assigneeId: string;
  updatedAt: string;
}

function isTaskAsRead(read: TaskAsRead | undefined): boolean {
  return (
    read === undefined ||
    (isSnowflake(read.assigneeId) && isInstant(new Date(read.updatedAt)))
  );
}

/**
 * Returns a claim token, or null if someone else holds it, the task has moved on, or
 * its event, channel or guild no longer allow reminders.
 */
export async function claimReminder(
  db: DbClient,
  key: ReminderKey & { asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (!isReminderKey(key) || !isTaskAsRead(key.asRead)) {
    return refused();
  }
  return nullableUuidValue(
    await callFunction(
      db,
      fragment`public.claim_reminder(p_task_id => ${key.taskId}, p_kind => ${key.kind}, p_due_date => ${key.dueDate}, p_assignee_id => ${key.asRead?.assigneeId ?? null}, p_updated_at => ${key.asRead?.updatedAt ?? null})`,
    ),
  );
}

/** The most reminders one batch call takes. A run's batch is one message, far fewer. */
export const MAX_REMINDER_BATCH = 100;

/**
 * Runs a batch call for the items that pass `isValid`, and gives each item the answer
 * the single-item call would have given it: a refusal for an invalid item, and otherwise
 * that item's part of the batch's answer. A batch that fails fails every item it held.
 */
async function perItem<K, T>(
  keys: readonly K[],
  isValid: (key: K) => boolean,
  call: (valid: readonly K[]) => Promise<DbResult<readonly DbResult<T>[]>>,
): Promise<DbResult<readonly DbResult<T>[]>> {
  // A loop and not .filter(), which is a query method the lint keeps out of this folder.
  const valid: K[] = [];
  for (const key of keys) {
    if (isValid(key)) {
      valid.push(key);
    }
  }
  if (valid.length > MAX_REMINDER_BATCH) {
    return refused();
  }
  const answers = valid.length === 0 ? null : await call(valid);
  if (answers !== null && !answers.ok) {
    return answers;
  }
  let next = 0;
  return {
    ok: true,
    value: keys.map((key) => {
      if (!isValid(key)) {
        return refused();
      }
      const answer = answers?.value[next];
      next += 1;
      return answer ?? failure("bad_row");
    }),
  };
}

/** A JSON array with exactly one element per item, each read by `read`. */
function batchAnswers<T>(
  result: DbResult<unknown>,
  count: number,
  read: (element: unknown) => DbResult<T>,
): DbResult<readonly DbResult<T>[]> {
  if (!result.ok) {
    return result;
  }
  const { value } = result;
  return Array.isArray(value) && value.length === count
    ? { ok: true, value: (value as unknown[]).map(read) }
    : failure("bad_row");
}

function claimAnswer(element: unknown): DbResult<string | null> {
  if (typeof element !== "object" || element === null) {
    return failure("bad_row");
  }
  const { claim_token: token, changed } = element as Record<string, unknown>;
  if (changed === true && token === null) {
    return failure("task_changed", "CF412");
  }
  return changed === false && (token === null || isUuid(token))
    ? { ok: true, value: token }
    : failure("bad_row");
}

/**
 * `claimReminder` for each of several reminders, in one call. Each item's answer is the
 * one `claimReminder` would give it, a `task_changed` failure included. Failing as a
 * whole means no item was claimed.
 */
export async function claimReminders(
  db: DbClient,
  keys: readonly (ReminderKey & { asRead?: TaskAsRead | undefined })[],
): Promise<DbResult<readonly DbResult<string | null>[]>> {
  return perItem(
    keys,
    (key) => isReminderKey(key) && isTaskAsRead(key.asRead),
    async (valid) =>
      batchAnswers(
        await callFunction(
          db,
          fragment`public.claim_reminders(p_task_ids => ${fragment.param(valid.map((key) => key.taskId))}::text[]::uuid[], p_kinds => ${fragment.param(valid.map((key) => key.kind))}::text[]::public.reminder_kind[], p_due_dates => ${fragment.param(valid.map((key) => key.dueDate))}::text[]::date[], p_assignee_ids => ${fragment.param(valid.map((key) => key.asRead?.assigneeId ?? null))}::text[]::text[], p_updated_ats => ${fragment.param(valid.map((key) => key.asRead?.updatedAt ?? null))}::text[]::timestamp with time zone[])`,
        ),
        valid.length,
        claimAnswer,
      ),
  );
}

/** Takes over a stale claim given its last token. Null if that is no longer possible. */
export async function reclaimReminder(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<string | null>> {
  if (
    !isReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isTaskAsRead(key.asRead)
  ) {
    return refused();
  }
  return nullableUuidValue(
    await callFunction(
      db,
      fragment`public.reclaim_reminder(p_task_id => ${key.taskId}, p_kind => ${key.kind}, p_due_date => ${key.dueDate}, p_claim_token => ${key.claimToken}, p_assignee_id => ${key.asRead?.assigneeId ?? null}, p_updated_at => ${key.asRead?.updatedAt ?? null})`,
    ),
  );
}

export type StaleClaimOutcome =
  /** Taken over. Send the reminder and mark it with this token. */
  | { readonly outcome: "reclaimed"; readonly claimToken: string }
  /** The task is done, deleted or moved, so the claim was recorded as skipped. */
  | { readonly outcome: "closed" }
  /** Left alone and may come back: fresh, reminders paused, or someone else's now. */
  | { readonly outcome: "left" };

/**
 * Deals with one claim from `listStaleClaims`. Without this, a claim on a finished
 * task would stay listed forever, since a reclaim refuses it. A claim is closed only
 * when its task is finished, not when reminders are merely paused, because a closed
 * claim would not go out if they were turned back on.
 */
export async function resolveStaleClaim(
  db: DbClient,
  key: ReminderKey & { claimToken: string; asRead?: TaskAsRead | undefined },
): Promise<DbResult<StaleClaimOutcome>> {
  const reclaimed = await reclaimReminder(db, key);
  if (!reclaimed.ok) {
    return reclaimed;
  }
  if (reclaimed.value !== null) {
    return {
      ok: true,
      value: { outcome: "reclaimed", claimToken: reclaimed.value },
    };
  }

  return closeStaleClaim(db, key);
}

/**
 * Closes a stale claim if its task is finished, and otherwise leaves it exactly as it
 * is, with no takeover and no rise in `attempts`. For a claim the run has no intention
 * of sending, such as one on a task the plan left out.
 */
export async function closeStaleClaim(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<Exclude<StaleClaimOutcome, { outcome: "reclaimed" }>>> {
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  const claim = oneOrNone(
    await run(db, (sql) =>
      sql
        .select({
          state: reminderLog.state,
          claim_token: reminderLog.claimToken,
        })
        .from(reminderLog)
        .where(
          and(
            eq(reminderLog.taskId, key.taskId),
            eq(reminderLog.kind, key.kind),
            eq(reminderLog.dueDate, key.dueDate),
          ),
        )
        .limit(1),
    ),
    parseClaimState,
  );
  if (!claim.ok) {
    return claim;
  }
  if (
    claim.value?.state !== "claimed" ||
    claim.value.claim_token !== key.claimToken
  ) {
    return { ok: true, value: { outcome: "left" } };
  }

  const task = oneOrNone(
    await run(db, (sql) =>
      sql
        .select({
          due_date: tasks.dueDate,
          status: tasks.status,
          deleted_at: tasks.deletedAt,
        })
        .from(tasks)
        .where(eq(tasks.id, key.taskId))
        .limit(1),
    ),
    parseTaskLiveness,
  );
  if (!task.ok) {
    return task;
  }
  const stillDue =
    task.value !== null &&
    task.value.status === "open" &&
    task.value.deleted_at === null &&
    task.value.due_date === key.dueDate;
  if (stillDue) {
    return { ok: true, value: { outcome: "left" } };
  }

  const skipped = await markReminderSkipped(db, key);
  if (!skipped.ok) {
    return skipped;
  }
  return { ok: true, value: { outcome: skipped.value ? "closed" : "left" } };
}

/** False if the token no longer holds the claim. */
export async function markReminderSent(
  db: DbClient,
  key: ReminderKey & { claimToken: string; messageId: string },
): Promise<DbResult<boolean>> {
  if (
    !isReminderKey(key) ||
    !isUuid(key.claimToken) ||
    !isSnowflake(key.messageId)
  ) {
    return refused();
  }
  return booleanValue(
    await callFunction(
      db,
      fragment`public.mark_reminder_sent(p_task_id => ${key.taskId}, p_kind => ${key.kind}, p_due_date => ${key.dueDate}, p_claim_token => ${key.claimToken}, p_message_id => ${key.messageId})`,
    ),
  );
}

/**
 * `markReminderSent` for each of several claims, all ended by the one message, in one
 * call. Failing as a whole means no item was marked.
 */
export async function markRemindersSent(
  db: DbClient,
  {
    keys,
    messageId,
  }: {
    keys: readonly (ReminderKey & { claimToken: string })[];
    messageId: string;
  },
): Promise<DbResult<readonly DbResult<boolean>[]>> {
  return perItem(
    keys,
    (key) =>
      isReminderKey(key) && isUuid(key.claimToken) && isSnowflake(messageId),
    async (valid) =>
      batchAnswers(
        await callFunction(
          db,
          fragment`public.mark_reminders_sent(p_task_ids => ${fragment.param(valid.map((key) => key.taskId))}::text[]::uuid[], p_kinds => ${fragment.param(valid.map((key) => key.kind))}::text[]::public.reminder_kind[], p_due_dates => ${fragment.param(valid.map((key) => key.dueDate))}::text[]::date[], p_claim_tokens => ${fragment.param(valid.map((key) => key.claimToken))}::text[]::uuid[], p_message_id => ${messageId})`,
        ),
        valid.length,
        (element) =>
          typeof element === "boolean"
            ? { ok: true, value: element }
            : failure("bad_row"),
      ),
  );
}

/** False if the token no longer holds the claim. */
export async function markReminderSkipped(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return booleanValue(
    await callFunction(
      db,
      fragment`public.mark_reminder_skipped(p_task_id => ${key.taskId}, p_kind => ${key.kind}, p_due_date => ${key.dueDate}, p_claim_token => ${key.claimToken})`,
    ),
  );
}

/**
 * Records that this claim's send is known not to have reached anyone, so it does not count
 * as a message someone may have been notified by. False if the token no longer holds the
 * claim, or this attempt has been recorded already.
 */
export async function recordReminderRefused(
  db: DbClient,
  key: ReminderKey & { claimToken: string },
): Promise<DbResult<boolean>> {
  if (!isReminderKey(key) || !isUuid(key.claimToken)) {
    return refused();
  }
  return booleanValue(
    await callFunction(
      db,
      fragment`public.record_reminder_refused(p_task_id => ${key.taskId}, p_kind => ${key.kind}, p_due_date => ${key.dueDate}, p_claim_token => ${key.claimToken})`,
    ),
  );
}

export interface ThreadRefusalKey {
  guildId: string;
  eventId: string;
}

function isThreadRefusalKey({ guildId, eventId }: ThreadRefusalKey): boolean {
  return isSnowflake(guildId) && isUuid(eventId);
}

/** Returns how many runs in a row this event's thread has now refused the bot. */
export async function recordThreadRefusal(
  db: DbClient,
  key: ThreadRefusalKey,
): Promise<DbResult<number>> {
  if (!isThreadRefusalKey(key)) {
    return refused();
  }
  const response = await callFunction(
    db,
    fragment`public.record_thread_refusal(p_event_id => ${key.eventId}, p_guild_id => ${key.guildId})`,
  );
  // The function returns null when there is no live event with that ID in that guild.
  if (response.ok && response.value === null) {
    return failure("not_found");
  }
  return integerValue(response);
}

/** For after a send to the thread has landed. False if there was nothing to clear. */
export async function clearThreadRefusals(
  db: DbClient,
  key: ThreadRefusalKey,
): Promise<DbResult<boolean>> {
  if (!isThreadRefusalKey(key)) {
    return refused();
  }
  return booleanValue(
    await callFunction(
      db,
      fragment`public.clear_thread_refusals(p_event_id => ${key.eventId}, p_guild_id => ${key.guildId})`,
    ),
  );
}
