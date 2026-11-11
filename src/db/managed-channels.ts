import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { EVENT_COLUMNS, MANAGED_CHANNEL_COLUMNS } from "./columns.ts";
import { rest, run } from "./internal.ts";
import { events, managedChannels } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import {
  booleanValue,
  cappedList,
  oneOrNone,
  type CappedList,
} from "./result.ts";
import {
  parseEvent,
  parseManagedChannel,
  type EventRow,
  type ManagedChannel,
} from "./types.ts";
import { isSnowflakeList, snowflakeList } from "./validate.ts";

const MAX_CHANNELS = 500;

export async function getManagedChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<ManagedChannel | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(MANAGED_CHANNEL_COLUMNS)
        .from(managedChannels)
        .where(
          and(
            eq(managedChannels.guildId, guildId),
            eq(managedChannels.channelId, channelId),
          ),
        )
        .limit(1),
    ),
    parseManagedChannel,
  );
}

/**
 * The forum row of the live event in this guild whose post is this thread, or null if
 * the thread is no live event's post. Every way a post is attached checks that it is in
 * the event's forum, and a thread never moves, so the row names the thread's parent.
 */
export async function getEventThreadForum(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<ManagedChannel | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(threadId)) {
    return refused();
  }
  return oneOrNone(
    await run(db, (sql) =>
      sql
        .select(MANAGED_CHANNEL_COLUMNS)
        .from(events)
        .innerJoin(
          managedChannels,
          and(
            eq(managedChannels.guildId, events.guildId),
            eq(managedChannels.channelId, events.channelId),
          ),
        )
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.threadId, threadId),
            isNull(events.deletedAt),
          ),
        )
        .limit(1),
    ),
    parseManagedChannel,
  );
}

export async function listManagedChannels(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(MANAGED_CHANNEL_COLUMNS)
        .from(managedChannels)
        .where(eq(managedChannels.guildId, guildId))
        .orderBy(asc(managedChannels.channelId))
        .limit(MAX_CHANNELS + 1),
    ),
    parseManagedChannel,
    MAX_CHANNELS,
  );
}

/** Every active channel of every guild, for the health check. */
export async function listActiveManagedChannels(
  db: DbClient,
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(MANAGED_CHANNEL_COLUMNS)
        .from(managedChannels)
        .where(eq(managedChannels.status, "active"))
        .orderBy(asc(managedChannels.guildId), asc(managedChannels.channelId))
        .limit(MAX_CHANNELS + 1),
    ),
    parseManagedChannel,
    MAX_CHANNELS,
  );
}

/** The given channels that this guild has a row for, whatever their status. */
export async function listManagedChannelsByIds(
  db: DbClient,
  { guildId, channelIds }: { guildId: string; channelIds: readonly string[] },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  if (!isSnowflake(guildId) || !isSnowflakeList(channelIds)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(MANAGED_CHANNEL_COLUMNS)
        .from(managedChannels)
        .where(
          and(
            eq(managedChannels.guildId, guildId),
            inArray(managedChannels.channelId, snowflakeList(channelIds)),
          ),
        )
        .orderBy(asc(managedChannels.channelId))
        .limit(MAX_CHANNELS + 1),
    ),
    parseManagedChannel,
    MAX_CHANNELS,
  );
}

/**
 * This channel's live events that have a post, open or closed, last changed first. For
 * redrawing posts when a forum is added back. `limit` is the most it returns.
 */
export async function listRecentEventsInChannel(
  db: DbClient,
  {
    guildId,
    channelId,
    limit,
  }: { guildId: string; channelId: string; limit: number },
): Promise<DbResult<CappedList<EventRow>>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return cappedList(
    await run(db, (sql) =>
      sql
        .select(EVENT_COLUMNS)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.channelId, channelId),
            eq(events.threadStatus, "active"),
            isNull(events.deletedAt),
          ),
        )
        .orderBy(desc(events.updatedAt), asc(events.id))
        .limit(limit + 1),
    ),
    parseEvent,
    limit,
  );
}

/** For the health check. False if the channel was not active, which is not a failure. */
export async function markChannelUnavailable(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<boolean>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_channel_unavailable", {
      p_guild_id: guildId,
      p_channel_id: channelId,
    }),
  );
}
