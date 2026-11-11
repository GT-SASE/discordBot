/** What the task commands read about events: the post they run in, and the picker. */

import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import { EVENT_CHOICE_COLUMNS, EVENT_COLUMNS } from "./columns.ts";
import { run } from "./internal.ts";
import { events } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import { oneOrNone, rowList, type RowList } from "./result.ts";
import {
  parseEvent,
  parseEventChoice,
  type EventChoice,
  type EventRow,
} from "./types.ts";
import {
  idPrefixRange,
  isIdPrefix,
  isSearchTerm,
  searchPattern,
} from "./validate.ts";

/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

/** The live event a thread belongs to in this guild, whether open or closed. */
export async function findEventByThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(threadId)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(EVENT_COLUMNS)
        .from(events)
        .where(
          and(
            eq(events.threadId, threadId),
            eq(events.guildId, guildId),
            isNull(events.deletedAt),
          ),
        )
        .limit(1),
    ),
    parseEvent,
  );
}

/**
 * Any event this thread has belonged to and still names, live or soft-deleted. A deleted
 * event's post stays in the forum, so this tells it apart from a post nothing ever claimed.
 */
export async function findEventEverOnThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(threadId)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(EVENT_COLUMNS)
        .from(events)
        .where(and(eq(events.threadId, threadId), eq(events.guildId, guildId)))
        .limit(1),
    ),
    parseEvent,
  );
}

/** Autocomplete by the start of an event's ID, across events that can take tasks. */
export async function searchOpenEventsByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<EventChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await run(db, (sql) =>
      sql
        .select(EVENT_CHOICE_COLUMNS)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            gte(events.id, low),
            lte(events.id, high),
          ),
        )
        .orderBy(asc(events.id))
        .limit(MAX_CHOICES),
    ),
    parseEventChoice,
  );
}

/**
 * Autocomplete across the events a task can still be added to, latest date first. Nothing
 * closes a past event by itself, so the oldest first would crowd out the current ones.
 */
export async function searchOpenEvents(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<RowList<EventChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await run(db, (sql) =>
      sql
        .select(EVENT_CHOICE_COLUMNS)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            ilike(events.name, searchPattern(term)),
          ),
        )
        .orderBy(desc(events.eventDate), asc(events.id))
        .limit(MAX_CHOICES),
    ),
    parseEventChoice,
  );
}
