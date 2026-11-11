/**
 * Task reads and writes. Each write repeats its checks in the update's filters, so a
 * change made between a permission check and the write stops the write.
 *
 * A task is never undeleted here. The only write to `deleted_at` needs it to be null
 * already, and sets a timestamp, and every other write also needs it null. A task
 * deleted along with its event therefore stays deleted.
 */

import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import {
  and,
  asc,
  eq,
  gte,
  ilike,
  isNull,
  lte,
  sql as fragment,
} from "drizzle-orm";
import {
  LIVE_TASK_CHOICE_COLUMNS,
  TASK_CHOICE_COLUMNS,
  TASK_COLUMNS,
} from "./columns.ts";
import { callFunction, run } from "./internal.ts";
import { events, taskInserts, tasks } from "./schema.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  cappedList,
  exactlyOne,
  jsonRows,
  oneOrNone,
  rowList,
  type CappedList,
  type RowList,
} from "./result.ts";
import {
  parseLiveTaskChoice,
  parseOpenTask,
  parseTask,
  parseTaskChoice,
  parseTaskId,
  type LiveTaskChoice,
  type OpenTask,
  type TaskChoice,
  type TaskRow,
} from "./types.ts";
import {
  MAX_TASK_DESCRIPTION_LENGTH,
  idPrefixRange,
  isDbDate,
  isIdPrefix,
  isInstant,
  isSearchTerm,
  isStoredText,
  isTimestampText,
  isUuid,
  searchPattern,
} from "./validate.ts";

const MAX_TASKS = 100;
/** Enforced by a trigger on tasks: see db/migrations/0001_baseline.sql. */
export const MAX_TASKS_PER_EVENT = 100;
/** New tasks and reassignments together. Enforced by triggers in the same file. */
export const MAX_TASK_ACTIONS_PER_OFFICER_PER_DAY = 50;
/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

/** A task's event, which is in the same guild by the foreign key. */
const TASK_EVENT = and(
  eq(events.id, tasks.eventId),
  eq(events.guildId, tasks.guildId),
);

/** The task is live and its event is live and open. */
const ON_OPEN_EVENT = and(
  isNull(tasks.deletedAt),
  eq(events.status, "active"),
  isNull(events.deletedAt),
);

export interface TaskKey {
  guildId: string;
  taskId: string;
}

function isTaskKey({ guildId, taskId }: TaskKey): boolean {
  return isSnowflake(guildId) && isUuid(taskId);
}

/**
 * An edit names the version it was based on: the `updated_at` the caller read. The
 * database sets that column on every change and the bot's role cannot write it, so
 * if another edit got in first, this one matches no row and fails as `not_found`
 * instead of overwriting it.
 */
export interface TaskEditKey extends TaskKey {
  expectedUpdatedAt: string;
}

function isTaskEditKey(key: TaskEditKey): boolean {
  return isTaskKey(key) && isTimestampText(key.expectedUpdatedAt);
}

export interface NewTask {
  guildId: string;
  eventId: string;
  assigneeId: string;
  actorId: string;
  description: string;
  dueDate: DateOnly;
}

/**
 * Fails as `parent_unavailable` if the event is closed or deleted, as
 * `event_task_limit` if the event is full, and as `actor_task_limit` if this officer
 * has reached the daily limit. Any later change to the task but a soft delete also fails
 * as `parent_unavailable` once its event is closed.
 */
export async function createTask(
  db: DbClient,
  { guildId, eventId, assigneeId, actorId, description, dueDate }: NewTask,
): Promise<DbResult<TaskRow>> {
  if (
    !isSnowflake(guildId) ||
    !isUuid(eventId) ||
    !isSnowflake(assigneeId) ||
    !isSnowflake(actorId) ||
    !isStoredText(description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(dueDate)
  ) {
    return refused();
  }
  return exactlyOne(
    await run(db, (sql) =>
      sql
        .insert(taskInserts)
        .values({
          eventId: eventId,
          guildId: guildId,
          assigneeId: assigneeId,
          description: description,
          dueDate: dueDate,
          createdBy: actorId,
        })
        .returning(TASK_COLUMNS),
    ),
    parseTask,
  );
}

/** A live task in this guild. An ID from another guild looks like an unknown ID. */
export async function getTask(
  db: DbClient,
  key: TaskKey,
): Promise<DbResult<TaskRow | null>> {
  if (!isTaskKey(key)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            isNull(tasks.deletedAt),
          ),
        )
        .limit(1),
    ),
    parseTask,
  );
}

/**
 * One member's open tasks in one guild, soonest first, with each event's name. A task
 * on a closed or deleted event is finished with, so it is left out.
 */
export async function listOpenTasksForAssignee(
  db: DbClient,
  { guildId, assigneeId }: { guildId: string; assigneeId: string },
): Promise<DbResult<CappedList<OpenTask>>> {
  if (!isSnowflake(guildId) || !isSnowflake(assigneeId)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select({
          id: tasks.id,
          event_id: tasks.eventId,
          description: tasks.description,
          due_date: tasks.dueDate,
          events: { name: events.name },
        })
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.assigneeId, assigneeId),
            eq(tasks.status, "open"),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.id))
        .limit(MAX_TASKS + 1),
    ),
    parseOpenTask,
    MAX_TASKS,
  );
}

export interface OpenTaskCount {
  readonly count: number;
  /** True if there are more than `count`: the rows are capped, not all counted. */
  readonly truncated: boolean;
}

/** The open tasks of a forum's live events, for the warning before it is removed. */
export async function countOpenTasksInChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<OpenTaskCount>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  const list = cappedList(
    await run(db, (sql) =>
      sql
        .select({ id: tasks.id })
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
            eq(events.channelId, channelId),
            isNull(events.deletedAt),
          ),
        )
        .limit(MAX_TASKS + 1),
    ),
    parseTaskId,
    MAX_TASKS,
  );
  return list.ok
    ? {
        ok: true,
        value: {
          count: list.value.rows.length,
          truncated: list.value.truncated,
        },
      }
    : list;
}

/**
 * Every live task on one event, open ones first, then the soonest. The list is capped,
 * so this decides what is left out: never an open task in favour of finished ones.
 */
export async function listEventTasks(
  db: DbClient,
  { guildId, eventId }: { guildId: string; eventId: string },
): Promise<DbResult<CappedList<TaskRow>>> {
  if (!isSnowflake(guildId) || !isUuid(eventId)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.eventId, eventId),
            isNull(tasks.deletedAt),
          ),
        )
        .orderBy(asc(tasks.status), asc(tasks.dueDate), asc(tasks.id))
        .limit(MAX_TASKS + 1),
    ),
    parseTask,
    MAX_TASKS,
  );
}

/** Autocomplete across a guild's open tasks on open events, for officers. */
export async function searchOpenTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await run(db, (sql) =>
      sql
        .select(TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.status, "open"),
            ilike(tasks.description, searchPattern(term)),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseTaskChoice,
  );
}

/**
 * Autocomplete for /task delete: done tasks count towards an event's limit, so they can
 * be picked as well. Open ones come first, as the likelier choice.
 */
export async function searchLiveTasks(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<RowList<LiveTaskChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await run(db, (sql) =>
      sql
        .select(LIVE_TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            ilike(tasks.description, searchPattern(term)),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.status), asc(tasks.dueDate), asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseLiveTaskChoice,
  );
}

/** The same by the start of a task's ID. */
export async function searchLiveTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<LiveTaskChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await run(db, (sql) =>
      sql
        .select(LIVE_TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            gte(tasks.id, low),
            lte(tasks.id, high),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseLiveTaskChoice,
  );
}

/** Autocomplete across one member's own open tasks on open events. */
export async function searchOwnOpenTasks(
  db: DbClient,
  {
    guildId,
    assigneeId,
    term,
  }: { guildId: string; assigneeId: string; term: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(assigneeId) ||
    !isSearchTerm(term)
  ) {
    return refused();
  }
  return rowList(
    await run(db, (sql) =>
      sql
        .select(TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.assigneeId, assigneeId),
            eq(tasks.status, "open"),
            ilike(tasks.description, searchPattern(term)),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.dueDate), asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseTaskChoice,
  );
}

/** Autocomplete by the start of a task's ID, across a guild's open tasks on open events. */
export async function searchOpenTasksByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await run(db, (sql) =>
      sql
        .select(TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.status, "open"),
            gte(tasks.id, low),
            lte(tasks.id, high),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseTaskChoice,
  );
}

/** Autocomplete by the start of a task's ID, across one member's own open tasks. */
export async function searchOwnOpenTasksByIdPrefix(
  db: DbClient,
  {
    guildId,
    assigneeId,
    prefix,
  }: { guildId: string; assigneeId: string; prefix: string },
): Promise<DbResult<RowList<TaskChoice>>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(assigneeId) ||
    !isIdPrefix(prefix)
  ) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await run(db, (sql) =>
      sql
        .select(TASK_CHOICE_COLUMNS)
        .from(tasks)
        .innerJoin(events, TASK_EVENT)
        .where(
          and(
            eq(tasks.guildId, guildId),
            eq(tasks.assigneeId, assigneeId),
            eq(tasks.status, "open"),
            gte(tasks.id, low),
            lte(tasks.id, high),
            ON_OPEN_EVENT,
          ),
        )
        .orderBy(asc(tasks.id))
        .limit(MAX_CHOICES),
    ),
    parseTaskChoice,
  );
}

/**
 * Marks a member's own task done. Fails as `not_found` if the task was reassigned,
 * finished or deleted after the caller last read it.
 */
export async function markOwnTaskDone(
  db: DbClient,
  key: TaskKey & { assigneeId: string; now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskKey(key) || !isSnowflake(key.assigneeId) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await run(db, (sql) =>
      sql
        .update(tasks)
        .set({ status: "done", completedAt: key.now.toISOString() })
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            eq(tasks.assigneeId, key.assigneeId),
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning(TASK_COLUMNS),
    ),
    parseTask,
  );
}

/** Marks any open task in the guild done. Only for a caller checked as an officer. */
export async function markTaskDoneAsOfficer(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await run(db, (sql) =>
      sql
        .update(tasks)
        .set({ status: "done", completedAt: key.now.toISOString() })
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            eq(tasks.status, "open"),
            isNull(tasks.deletedAt),
          ),
        )
        .returning(TASK_COLUMNS),
    ),
    parseTask,
  );
}

/**
 * Sets all three editable fields in one write, so an edit of several either lands
 * whole or not at all. The caller passes the values it read for any left unchanged,
 * which is safe because the write only matches that version of the row. A new person
 * counts against the officer's daily limit in the same write: at the limit, nothing
 * changes and the edit fails as `actor_task_limit`.
 */
export async function editTask(
  db: DbClient,
  key: TaskEditKey & {
    description: string;
    dueDate: DateOnly;
    assigneeId: string;
    actorId: string;
  },
): Promise<DbResult<TaskRow>> {
  if (
    !isTaskEditKey(key) ||
    !isStoredText(key.description, MAX_TASK_DESCRIPTION_LENGTH) ||
    !isDbDate(key.dueDate) ||
    !isSnowflake(key.assigneeId) ||
    !isSnowflake(key.actorId)
  ) {
    return refused();
  }
  const edited = await callFunction(
    db,
    fragment`public.edit_task(p_task_id => ${key.taskId}, p_guild_id => ${key.guildId}, p_expected_updated_at => ${key.expectedUpdatedAt}, p_description => ${key.description}, p_due_date => ${key.dueDate}, p_assignee_id => ${key.assigneeId}, p_actor_id => ${key.actorId})`,
  );
  // Null when the task is not at the version read, or no longer open and live.
  if (edited.ok && edited.value === null) {
    return failure("not_found");
  }
  return exactlyOne(
    edited.ok ? jsonRows({ ok: true, value: [edited.value] }) : edited,
    parseTask,
  );
}

/**
 * Soft-deletes one live task, only if it is still the version the caller read. An
 * earlier edit, or a delete already done, fails as `not_found`.
 */
export async function softDeleteTaskIfUnchanged(
  db: DbClient,
  key: TaskEditKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskEditKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await run(db, (sql) =>
      sql
        .update(tasks)
        .set({ deletedAt: key.now.toISOString() })
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            eq(tasks.updatedAt, key.expectedUpdatedAt),
            isNull(tasks.deletedAt),
          ),
        )
        .returning(TASK_COLUMNS),
    ),
    parseTask,
  );
}

/** Soft-deletes one live task. A task already deleted fails as `not_found`. */
export async function softDeleteTask(
  db: DbClient,
  key: TaskKey & { now: Date },
): Promise<DbResult<TaskRow>> {
  if (!isTaskKey(key) || !isInstant(key.now)) {
    return refused();
  }
  return exactlyOne(
    await run(db, (sql) =>
      sql
        .update(tasks)
        .set({ deletedAt: key.now.toISOString() })
        .where(
          and(
            eq(tasks.id, key.taskId),
            eq(tasks.guildId, key.guildId),
            isNull(tasks.deletedAt),
          ),
        )
        .returning(TASK_COLUMNS),
    ),
    parseTask,
  );
}
