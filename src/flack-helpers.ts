import type { WebClient } from '@slack/web-api'
import { sql } from 'drizzle-orm'

import type { SlackAPIUser, SlackAPIMessage } from './slack-message-handler'
import db from './db/engine'
import type {
  SlackUser,
  SlackUserInsert,
  SlackChannelInsert } from './db/schema/main'
import {
  slackUserTable,
  slackChannelTable,
  slackMessageTable,
  topicTable,
} from './db/schema/main'

export const BOT_USER_ID = 'UTESTBOT'

export async function getOrCreateChannelForUsers(userIds: string[]): Promise<string> {
  // Sort userIds for consistent comparison (bot is NOT included)
  const sortedUserIds = [...userIds].sort()

  // Use transaction with a simple advisory lock for channel creation
  return await db.transaction(async (tx) => {
    // Acquire a single advisory lock for all channel creation operations
    // This prevents any race conditions during channel creation
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('getOrCreateChannelForUsers'))`)

    // Now we can safely check for existing channels
    const existingChannels = await tx.select().from(slackChannelTable)

    for (const channel of existingChannels) {
      const channelUsersSorted = [...channel.userIds].sort()
      if (channelUsersSorted.length === sortedUserIds.length &&
          channelUsersSorted.every((id, index) => id === sortedUserIds[index])) {
        return channel.id
      }
    }

    // Otherwise, create new channel
    const newChannelId = userIds.length === 2 ? `D${Date.now()}` : `G${Date.now()}`
    const channelToInsert: SlackChannelInsert = {
      id: newChannelId,
      userIds: sortedUserIds,
    }

    await tx.insert(slackChannelTable).values(channelToInsert)
    return newChannelId
  })
}

export async function upsertFakeUser(params: {
  id: string,
  realName: string,
  isBot?: boolean,
  tz?: string
}): Promise<SlackUser> {
  const userToUpsert: SlackUserInsert = {
    id: params.id,
    teamId: 'T123456',
    realName: params.realName,
    deleted: false,
    isBot: params.isBot || false,
    updated: new Date(),
    tz: params.tz || 'America/New_York',
    raw: {},
  }

  const [user] = await db
    .insert(slackUserTable)
    .values(userToUpsert)
    .onConflictDoUpdate({
      target: slackUserTable.id,
      set: {
        teamId: sql.raw('excluded.team_id'),
        realName: sql.raw('excluded.real_name'),
        tz: sql.raw('excluded.tz'),
        isBot: sql.raw('excluded.is_bot'),
        deleted: sql.raw('excluded.deleted'),
        updated: sql.raw('excluded.updated'),
        raw: sql.raw('excluded.raw'),
      },
    }).returning()

  return user
}

/**
 * Efficiently clears all test data from the database using TRUNCATE
 * Falls back to DELETE if TRUNCATE fails (e.g., due to permissions)
 * Recreate bot user after truncating user table
 */
export const cleanupTestData = async () => {
  try {
    // TRUNCATE is faster and resets auto-increment counters
    // CASCADE handles foreign key constraints automatically
    await db.execute(sql`TRUNCATE TABLE ${slackChannelTable} CASCADE`)
    await db.execute(sql`TRUNCATE TABLE ${slackUserTable} CASCADE`)
    await db.execute(sql`TRUNCATE TABLE ${slackMessageTable} CASCADE`)
    await db.execute(sql`TRUNCATE TABLE ${topicTable} CASCADE`)
    console.log('✅ Database cleared using TRUNCATE')
    return { method: 'TRUNCATE', success: true }
  } catch (error) {
    // Fallback to DELETE if TRUNCATE fails
    console.log('TRUNCATE failed, falling back to DELETE:', error)
    try {
      // Delete in correct order for foreign key constraints
      await db.delete(slackChannelTable)
      await db.delete(slackUserTable)
      await db.delete(slackMessageTable)
      await db.delete(topicTable)
      console.log('✅ Database cleared using DELETE')
      return { method: 'DELETE', success: true }
    } catch (deleteError) {
      console.error('Failed to clear database:', deleteError)
      throw deleteError
    }
  } finally {
    await upsertFakeUser({ id: BOT_USER_ID, realName: 'Pivotal', isBot: true })
  }
}

export const mockSlackClient = {
  users: {
    list: async () => {
      // Query slack users from database
      const dbUsers = await db.select().from(slackUserTable)
      // Convert database users to SlackAPIUser format
      const members: SlackAPIUser[] = dbUsers.map((user) => ({
        id: user.id,
        team_id: user.teamId,
        real_name: user.realName || '',
        deleted: user.deleted,
        is_bot: user.isBot,
        updated: Math.floor(user.updated.getTime() / 1000),
        tz: user.tz || 'America/New_York',
      }))

      return {
        ok: true,
        members,
        response_metadata: {},
      }
    },
  },
  conversations: {
    open: async ({ users }: { users: string }) => {
      // Get or create channel for the specified users
      const userList = users.split(',')
      const channelId = await getOrCreateChannelForUsers(userList)

      return {
        ok: true,
        channel: {
          id: channelId,
          created: Math.floor(Date.now() / 1000),
          is_im: userList.length === 1,
          is_mpim: userList.length > 1,
        },
      }
    },
  },
  chat: {
    postMessage: async (params: { channel: string; text: string; thread_ts?: string }) => {
      const timestamp = (Date.now() / 1000).toString()

      // Prepare the message as SlackAPIMessage
      const message: SlackAPIMessage = {
        type: 'message',
        subtype: undefined,
        channel: params.channel,
        text: params.text,
        ts: timestamp,
        thread_ts: params.thread_ts,
        user: '', // This field is not used by the caller downstream
        channel_type: params.channel.startsWith('D') ? 'im' : 'channel',
        event_ts: timestamp,
      }

      return Promise.resolve({
        ok: true,
        ts: timestamp,
        message: message,
      })
    },
  },
  reactions: {
    add: async () => {},
  },
} as unknown as WebClient
