import fs from 'fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import path from 'node:path'
import { eq, desc, inArray, and, sql, lt, isNotNull, max } from 'drizzle-orm'
import { z } from 'zod'
import { CronJob } from 'cron'
import { RRuleTemporal } from 'rrule-temporal'
import { Temporal } from '@js-temporal/polyfill'

import db from './db/engine'
import type {
  SlackMessage,
  SlackUser,
  TopicInsert,
  SlackUserInsert,
  SlackChannelInsert,
  UserDataInsert,
  AutoMessage,
  TopicStateInsert,
} from './db/schema/main'
import {
  slackMessageTable,
  topicTable,
  topicStateTable,
  slackUserTable,
  slackChannelTable,
  userDataTable,
  autoMessageTable,
} from './db/schema/main'
import type { TopicData, TopicDataRes } from '@shared/api-types'
import { unserializeTopicData } from '@shared/api-types'
import { getShortTimezoneFromIANA } from '@shared/utils'
import type { SlackAPIMessage } from './slack-message-handler'
import { handleSlackMessage } from './slack-message-handler'
import { getOrCreateChannelForUsers } from './local-helpers'
import type { AutoMessageDeactivation, TopicWithState, TopicStateWithMessageTs } from '@shared/api-types'
import type { WebClient } from '@slack/web-api'

export function tsToDate(ts: string): Date {
  return new Date(Number(ts) * 1000)
}

export async function getTopicWithState(topicId: string): Promise<TopicWithState> {
  // Get the topic along with its most recent state
  const [row] = await db
    .select()
    .from(topicTable)
    .innerJoin(topicStateTable, eq(topicTable.id, topicStateTable.topicId))
    .where(eq(topicTable.id, topicId))
    .orderBy(desc(topicStateTable.createdAt))
    .limit(1)

  if (!row) {
    throw new Error(`Topic with id ${topicId} not found`)
  }

  return {
    ...row.topic,
    state: row.topic_state,
  }
}

export async function getTopics(
  botUserId: string | null = null,
  onlyActive: boolean = false,
  topicIds?: string[],
): Promise<TopicWithState[]> {
  const filters = []
  if (botUserId) {
    filters.push(eq(topicTable.botUserId, botUserId))
  }
  if (onlyActive) {
    filters.push(eq(topicStateTable.isActive, true))
  }
  if (topicIds) {
    if (topicIds.length === 0) {
      return []
    }
    filters.push(inArray(topicTable.id, topicIds))
  }

  const latestStateSubquery = db
    .select({ maxDate: max(topicStateTable.createdAt) })
    .from(topicStateTable)
    .where(eq(topicStateTable.topicId, topicTable.id))

  const rows = await db
    .select()
    .from(topicTable)
    .innerJoin(
      topicStateTable,
      and(
        eq(topicTable.id, topicStateTable.topicId),
        eq(topicStateTable.createdAt, latestStateSubquery),
      ),
    )
    .where(and(...filters))
    .orderBy(desc(topicStateTable.createdAt))

  return rows.map((row) => ({
    ...row.topic,
    state: row.topic_state,
  }))
}

export async function updateTopicState(
  topic: TopicWithState,
  updates: Partial<Omit<TopicStateInsert, 'id' | 'topicId' | 'createdByMessageId' | 'createdAt'>>,
  messageId: string,
): Promise<TopicWithState> {
  // Don't pass the current state id or createdAt when creating the new state
  const {
    id: _id,
    createdAt: _createdAt,
    ...currentState
  } = topic.state

  // Create new topic state by merging current state with updates
  const [newTopicState] = await db
    .insert(topicStateTable)
    .values({
      ...currentState,
      ...updates,
      createdByMessageId: messageId,
    })
    .returning()

  // Return the updated topic with new state
  return {
    ...topic,
    state: newTopicState,
  }
}

export async function getStatesWithMessageTs(topicId: string): Promise<TopicStateWithMessageTs[]> {
  // Fetch all states for this topic in chronological order with the rawTs from their creating message
  const statesWithMessageTs = await db
    .select({
      state: topicStateTable,
      createdByMessageRawTs: slackMessageTable.rawTs,
    })
    .from(topicStateTable)
    .innerJoin(slackMessageTable, eq(topicStateTable.createdByMessageId, slackMessageTable.id))
    .where(eq(topicStateTable.topicId, topicId))
    .orderBy(topicStateTable.createdAt)

  return statesWithMessageTs.map(({ state, createdByMessageRawTs }) => ({
    ...state,
    createdByMessageRawTs,
  }))
}

export const GetTopicReq = z.strictObject({
  lastMessageId: z.string().optional(),
  visibleToUserId: z.string().optional(),
})
export type GetTopicReq = z.infer<typeof GetTopicReq>

export async function dumpTopic(topicId: string, options: GetTopicReq = {}): Promise<TopicData> {
  const { lastMessageId, visibleToUserId } = options

  const [topic] = await db.select()
    .from(topicTable)
    .where(eq(topicTable.id, topicId))

  let states = await getStatesWithMessageTs(topicId)

  // Build the messages query with optional channel filtering
  let messages: SlackMessage[]

  if (visibleToUserId) {
    const messagesResult = await db.select({ message: slackMessageTable })
      .from(slackMessageTable)
      .innerJoin(slackChannelTable, eq(slackMessageTable.channelId, slackChannelTable.id))
      .where(
        and(
          eq(slackMessageTable.topicId, topicId),
          sql`${slackChannelTable.userIds}::jsonb @> ${JSON.stringify([visibleToUserId])}::jsonb`,
        ),
      )
      .orderBy(slackMessageTable.timestamp)

    messages = messagesResult.map((row) => row.message)
  } else {
    // Simple query without join
    messages = await db
      .select()
      .from(slackMessageTable)
      .where(eq(slackMessageTable.topicId, topicId))
      .orderBy(slackMessageTable.timestamp)
  }

  // If lastMessageId is provided, filter messages up to and including that message
  if (lastMessageId) {
    const targetMessage = messages.find((msg) => msg.id === lastMessageId)
    if (!targetMessage) {
      throw new Error(`Message with id ${lastMessageId} not found in topic ${topicId}`)
    }
    // Filter to only include messages and states up to and including the target message's timestamp
    messages = messages.filter((msg) =>
      Number(msg.rawTs) <= Number(targetMessage.rawTs),
    )
    states = states.filter((state) =>
      Number(state.createdByMessageRawTs) <= Number(targetMessage.rawTs),
    )
  }

  // Collect all unique userIds from all topic states
  const allUserIds = new Set<string>()
  for (const state of states) {
    for (const userId of state.userIds) {
      allUserIds.add(userId)
    }
  }
  const userIdsArray = Array.from(allUserIds)

  // Fetch users that are referenced in any topic state
  const users = userIdsArray.length > 0
    ? await db
        .select()
        .from(slackUserTable)
        .where(inArray(slackUserTable.id, userIdsArray))
    : []

  // Fetch userData for users referenced in any topic state
  const userData = userIdsArray.length > 0
    ? await db
        .select()
        .from(userDataTable)
        .where(inArray(userDataTable.slackUserId, userIdsArray))
    : []

  // Fetch unique channel IDs from messages
  const channelIds = [...new Set(messages.map((msg) => msg.channelId))]
  const channels = channelIds.length > 0
    ? await db
        .select()
        .from(slackChannelTable)
        .where(inArray(slackChannelTable.id, channelIds))
    : []

  const result: TopicData = {
    topic,
    states,
    messages,
    users,
    userData,
    channels,
  }

  return result
}

export async function loadTopics(jsonData: string): Promise<{ topicIds: string[] }> {
  // Parse string input if needed
  const parsedData = JSON.parse(jsonData) as TopicDataRes | TopicDataRes[]

  // Normalize to array with Date objects
  const topicReqsArray: TopicDataRes[] = Array.isArray(parsedData) ? parsedData : [parsedData]
  const topicsArray: TopicData[] = topicReqsArray.map((topicRes) => unserializeTopicData(topicRes))

  const topicIds: string[] = []

  for (const data of topicsArray) {
    // Insert or update users
    if (data.users && data.users.length > 0) {
      for (const user of data.users) {
        const userInsert: SlackUserInsert = { ...user }
        await db
          .insert(slackUserTable)
          .values(userInsert)
          .onConflictDoUpdate({
            target: slackUserTable.id,
            set: {
              teamId: userInsert.teamId,
              realName: userInsert.realName,
              tz: userInsert.tz,
              isBot: userInsert.isBot,
              deleted: userInsert.deleted,
              updated: userInsert.updated,
              raw: userInsert.raw,
            },
          })
      }
    }

    // Insert or update userData
    if (data.userData && data.userData.length > 0) {
      for (const userDataItem of data.userData) {
        const userDataInsert: UserDataInsert = { ...userDataItem }
        delete userDataInsert.id
        await db
          .insert(userDataTable)
          .values(userDataInsert)
          .onConflictDoUpdate({
            target: userDataTable.slackUserId,
            set: {
              context: userDataInsert.context,
              updatedAt: new Date(),
            },
          })
      }
    }

    // Insert or update channels
    if (data.channels && data.channels.length > 0) {
      for (const channel of data.channels) {
        const channelInsert: SlackChannelInsert = { ...channel }
        await db
          .insert(slackChannelTable)
          .values(channelInsert)
          .onConflictDoUpdate({
            target: slackChannelTable.id,
            set: {
              userIds: channelInsert.userIds,
            },
          })
      }
    }

    // Insert topic (excluding id to let DB generate new one)
    const topicData: TopicInsert = { ...data.topic }
    delete topicData.id
    const [insertedTopic] = await db
      .insert(topicTable)
      .values(topicData)
      .returning()

    // Create a map from old message IDs to new message IDs
    const messageIdMap = new Map<string, string>()

    // Insert messages with new IDs
    if (data.messages.length > 0) {
      for (const msg of data.messages) {
        const { id: oldId, ...msgData } = msg
        const [insertedMsg] = await db.insert(slackMessageTable)
          .values({ ...msgData, topicId: insertedTopic.id })
          .returning()
        messageIdMap.set(oldId, insertedMsg.id)
      }
    }

    // Insert topic states with new IDs and mapped message references
    if (data.states && data.states.length > 0) {
      for (const state of data.states) {
        const stateData: TopicStateInsert = { ...state }
        delete stateData.id
        stateData.createdByMessageId = messageIdMap.get(stateData.createdByMessageId)!
        await db.insert(topicStateTable)
          .values({ ...stateData, topicId: insertedTopic.id })
      }
    }

    topicIds.push(insertedTopic.id)
  }

  return { topicIds }
}

export function replaceUserMentions(text: string, userMap: Map<string, SlackUser>): string {
  if (!userMap || userMap.size === 0) {
    return text
  }
  // Replace all <@USERID> patterns with the user's name
  return text.replace(/<@([A-Z0-9]+)>/g, (match, userId: string) => {
    const userName = userMap.get(userId)?.realName
    return userName ? `<@${userName}>` : match
  })
}

export async function organizeMessagesByChannelAndThread(
  messages: SlackMessage[],
  timezone: string,
): Promise<string> {
  if (messages.length === 0) {
    return 'No previous messages'
  }

  // Group messages by channel and thread
  const messageGroups = messages.reduce((acc, msg) => {
    const channelKey = msg.channelId
    // Use message timestamp as thread key if no thread timestamp found
    const threadKey = msg.threadTs || msg.rawTs

    if (!acc[channelKey]) {
      acc[channelKey] = {}
    }
    if (!acc[channelKey][threadKey]) {
      acc[channelKey][threadKey] = []
    }

    acc[channelKey][threadKey].push(msg)
    return acc
  }, {} as Record<string, Record<string, SlackMessage[]>>)

  // Get channel information for all channels
  const channelIds = Object.keys(messageGroups)
  const channels = channelIds.length > 0
    ? await db
        .select()
        .from(slackChannelTable)
        .where(inArray(slackChannelTable.id, channelIds))
    : []
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))

  // Collect all unique userIds from channels and messages
  const allUserIds = new Set<string>()
  // Add userIds from channels (bot is not included in channel userIds)
  // This is needed for users where the bot has sent a message but that user has not yet replied
  for (const channel of channels) {
    for (const userId of channel.userIds) {
      allUserIds.add(userId)
    }
  }
  // Add userIds from messages (this will include the bot when it sends messages)
  for (const msg of messages) {
    allUserIds.add(msg.userId)
  }

  // Get user information including names and timezones
  const userIdsArray = Array.from(allUserIds)
  const users = userIdsArray.length > 0
    ? await db
        .select()
        .from(slackUserTable)
        .where(inArray(slackUserTable.id, userIdsArray))
    : []
  const userMap = new Map(users.map((u) => [u.id, u]))

  // Sort messages within each group by timestamp and format output
  let output = ''
  for (const [channelId, threads] of Object.entries(messageGroups)) {
    // Get channel users and format channel name
    const channel = channelMap.get(channelId)
    let channelName = `Channel ${channelId}`
    let channelTimezone = timezone // Default to caller's timezone

    if (channel && channel.userIds) {
      const channelUserNames = channel.userIds.map((id: string) => {
        const user = userMap.get(id)
        const name = user?.realName || 'Unknown User'
        const tz = user?.tz
        return tz ? `${name} (${getShortTimezoneFromIANA(tz)})` : name
      })

      if (channel.userIds.length === 1) {
        channelName = `DM with ${channelUserNames[0]}`
        // For DMs, use the recipient's timezone
        const dmRecipient = userMap.get(channel.userIds[0])
        if (dmRecipient?.tz) {
          channelTimezone = dmRecipient.tz
        }
      } else if (channel.userIds.length > 1) {
        channelName = `Group channel with ${channelUserNames.join(', ')}`
        // For group channels, keep using the caller's timezone
      }
    }

    output += `${channelName}:\n`

    // Sort threads by threadId converted to number
    const sortedThreads = Object.entries(threads).sort(([aId], [bId]) => {
      return Number(aId) - Number(bId)
    })

    sortedThreads.forEach(([threadId, messages]) => {
      // Only show thread header if there's more than one message in the thread
      if (messages.length > 1) {
        // Convert threadId (timestamp string) to formatted date
        const threadDate = tsToDate(threadId)
        const threadTimestamp = channelTimezone ?
          threadDate.toLocaleString('en-US', {
            timeZone: channelTimezone,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }) : threadDate.toLocaleString()
        const threadTzAbbr = channelTimezone ? getShortTimezoneFromIANA(channelTimezone) : ''
        output += `  Thread [${threadTimestamp}${threadTzAbbr ? ` (${threadTzAbbr})` : ''}]:\n`
      }

      // Sort messages by timestamp
      const sortedMessages = messages.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )

      sortedMessages.forEach((msg) => {
        // Adjust indent based on whether we're showing thread header
        const indent = messages.length > 1 ? '    ' : '  '
        const userName = userMap?.get(msg.userId)?.realName || 'Unknown User'
        const processedText = replaceUserMentions(msg.text, userMap)
        const msgDate = new Date(msg.timestamp)
        const timestampFormatted = channelTimezone ?
          msgDate.toLocaleString('en-US', {
            timeZone: channelTimezone,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }) : msgDate.toLocaleString()
        const tzAbbr = channelTimezone ? getShortTimezoneFromIANA(channelTimezone) : ''
        output += `${indent}[${timestampFormatted}${tzAbbr ? ` (${tzAbbr})` : ''}] ${userName}: "${processedText}"\n`
      })
    })
    output += '\n'
  }

  return output.trim()
}

export async function getChannelDescription(
  channelId: string,
  userMap: Map<string, SlackUser>,
): Promise<string> {
  const [channel] = await db
    .select()
    .from(slackChannelTable)
    .where(eq(slackChannelTable.id, channelId))
    .limit(1)

  let channelDescription = `Channel ${channelId}`
  if (channel && channel.userIds) {
    const channelUserNames = channel.userIds.map((id: string) => {
      const user = userMap.get(id)
      const name = user?.realName || 'Unknown User'
      const tz = user?.tz
      return tz ? `${name} (${getShortTimezoneFromIANA(tz)})` : name
    })

    if (channel.userIds.length === 1) {
      channelDescription = `DM with ${channelUserNames[0]}`
    } else if (channel.userIds.length > 1) {
      channelDescription = `Group channel with ${channelUserNames.join(', ')}`
    }
  }

  return channelDescription
}

// Helper function to format timestamp with timezone
export function formatTimestampWithTimezone(timestamp: Date | string, timezone?: string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  const formatted = date.toLocaleString('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  // Get abbreviated timezone
  const tzAbbr = timezone ? getShortTimezoneFromIANA(timezone) : 'UTC'

  return `${formatted} (${tzAbbr})`
}

async function checkAutoMessages(slackClient: WebClient): Promise<void> {
  try {
    // Query for auto messages where nextSendTime is before now and not null
    const now = new Date()
    const dueMessages = await db
      .select()
      .from(autoMessageTable)
      .where(
        and(
          isNotNull(autoMessageTable.nextSendTime),
          lt(autoMessageTable.nextSendTime, now),
        ),
      )

    // Process each due message
    await Promise.all(dueMessages.map((message) => sendAutoMessage(message, slackClient)))
  } catch (error) {
    console.error('Error checking auto messages:', error)
  }
}

async function sendAutoMessage(autoMessage: AutoMessage, slackClient: WebClient) {
  try {
    // First, update the autoMessage with next scheduled time or deactivate it.
    // Do this before processing the message to avoid error loops where we try
    // to send the message every minute and fail, and also to avoid the cron
    // firing again before the message finishes processing.
    await updateAutoMessageTime(autoMessage)

    // Get the original message that created this auto message
    const [originalMessage] = await db
      .select()
      .from(slackMessageTable)
      .where(eq(slackMessageTable.id, autoMessage.createdByMessageId))
      .limit(1)

    if (!originalMessage) {
      throw new Error(`Original message not found for auto message ${autoMessage.id}`)
    }

    // Get the topic to find the bot user ID
    const [topic] = await db
      .select()
      .from(topicTable)
      .where(eq(topicTable.id, originalMessage.topicId))
      .limit(1)

    if (!topic) {
      throw new Error(`Topic not found for auto message ${autoMessage.id}`)
    }

    const botUserId = topic.botUserId

    // Cannot use slackClient.conversations.open here because the real slack client
    // throws an error if we try to open a conversation for the bot with itself
    const channelId = await getOrCreateChannelForUsers([botUserId])

    // Create a SlackAPIMessage from the bot to itself
    const ts = (Date.now() / 1000).toString()
    const message: SlackAPIMessage = {
      type: 'message',
      subtype: undefined,
      text: autoMessage.text,
      ts: ts,
      user: botUserId,
      channel: channelId,
      channel_type: 'im',
      event_ts: ts,
    }

    // Determine if we should start a new topic or continue existing one
    const topicId = autoMessage.startNewTopic ? null : originalMessage.topicId

    await handleSlackMessage(
      message,
      botUserId,
      slackClient,
      topicId,
      true, // if topicId is null, create a new topic rather than routing to existing ones
      autoMessage.id,
    )


    console.log(`Auto message ${autoMessage.id} sent successfully`)
  } catch (error) {
    console.error(`Error sending auto message ${autoMessage.id}:`, error)
  }
}

async function updateAutoMessageTime(autoMessage: AutoMessage) {
  // Parse the RRULE and get the next occurrence after the current nextSendTime
  const rrule = new RRuleTemporal({
    rruleString: autoMessage.recurrenceSchedule.rrule,
  })
  // Use the current nextSendTime as the reference point for finding the next occurrence
  const referenceTime = autoMessage.nextSendTime
    ? Temporal.Instant.fromEpochMilliseconds(autoMessage.nextSendTime.getTime()).toZonedDateTimeISO('UTC')
    : Temporal.Now.zonedDateTimeISO('UTC')
  const nextOccurrence = rrule.next(referenceTime)

  if (nextOccurrence) {
    // Update with next scheduled time
    await db
      .update(autoMessageTable)
      .set({
        nextSendTime: new Date(nextOccurrence.epochMilliseconds),
      })
      .where(eq(autoMessageTable.id, autoMessage.id))
  } else {
    // No more occurrences, deactivate the message
    const deactivationMetadata: AutoMessageDeactivation = {
      deactivatedReason: 'expired',
      deactivatedAt: new Date().toISOString(),
    }

    await db
      .update(autoMessageTable)
      .set({
        nextSendTime: null,
        deactivationMetadata,
      })
      .where(eq(autoMessageTable.id, autoMessage.id))
  }
}

export function startAutoMessageCron(slackClient: WebClient): void {
  const job = new CronJob(
    '5 * * * * *', // Run at 5 seconds past every minute
    () => checkAutoMessages(slackClient),
  )
  job.start()
}

// Script execution when run directly
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
      output: {
        type: 'string',
        short: 'o',
      },
    },
    allowPositionals: true,
  })

  const command = positionals[0]

  if (values.help || !command) {
    console.log('Usage:')
    console.log('  tsx src/utils.ts dump <topicId> [messageId] [-o outputFile]')
    console.log('  tsx src/utils.ts load <jsonFile>')
    console.log('\nOptions:')
    console.log('  -h, --help     Show this help message')
    console.log('  -o, --output   Output file for dump command')
    process.exit(0)
  }

  if (command === 'dump') {
    const topicId = positionals[1]
    if (!topicId) {
      console.error('Error: topicId is required for dump command')
      console.error('Usage: tsx src/utils.ts dump <topicId> [messageId] [-o outputFile]')
      process.exit(1)
    }

    const messageId = positionals[2]
    const topicData = await dumpTopic(topicId, { lastMessageId: messageId })
    const jsonData = JSON.stringify(topicData, null, 2)
    if (values.output) {
      // Use INIT_CWD if available (set by pnpm/npm when running scripts from subdirectories)
      // Otherwise fall back to process.cwd()
      const workingDir = process.env.INIT_CWD || process.cwd()
      const resolvedPath = path.resolve(workingDir, values.output)

      await fs.writeFile(resolvedPath, jsonData)
      console.log(`Topic data written to ${resolvedPath}`)
    } else {
      console.log(jsonData)
    }

  } else if (command === 'load') {
    const jsonFile = positionals[1]
    if (!jsonFile) {
      console.error('Error: jsonFile is required for load command')
      console.error('Usage: tsx src/utils.ts load <jsonFile>')
      process.exit(1)
    }

    // Use INIT_CWD if available (set by pnpm/npm when running scripts from subdirectories)
    // Otherwise fall back to process.cwd()
    const workingDir = process.env.INIT_CWD || process.cwd()
    const resolvedPath = path.resolve(workingDir, jsonFile)

    const jsonData = await fs.readFile(resolvedPath, 'utf-8')
    const result = await loadTopics(jsonData)
    if (result.topicIds.length === 1) {
      console.log(`Topic loaded with new ID: ${result.topicIds[0]}`)
    } else {
      console.log(`${result.topicIds.length} topics loaded with IDs: ${result.topicIds.join(', ')}`)
    }

  } else {
    console.error(`Error: Unknown command '${command}'`)
    console.log('Usage:')
    console.log('  tsx src/utils.ts dump <topicId> [messageId] [-o outputFile]')
    console.log('  tsx src/utils.ts load <jsonFile>')
    process.exit(1)
  }

  // Clean up db connection for quicker exit
  process.exit(0)
}
