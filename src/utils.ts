import fs from 'fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { eq, inArray, and, sql } from 'drizzle-orm'
import { z } from 'zod'

import db from './db/engine'
import {
  slackMessageTable,
  SlackMessage,
  SlackMessageInsert,
  topicTable,
  TopicInsert,
  slackUserTable,
  SlackUserInsert,
  slackChannelTable,
  SlackChannelInsert,
  userDataTable,
  UserDataInsert,
} from './db/schema/main'
import { TopicRes, unserializeTopicTimestamps } from './shared/api-client'
import type { TopicData } from '@shared/api-types'

export function tsToDate(ts: string): Date {
  return new Date(Number(ts) * 1000)
}


export const GetTopicReq = z.strictObject({
  lastMessageId: z.string().optional(),
  visibleToUserId: z.string().optional(),
  beforeRawTs: z.string().optional(),
})
export type GetTopicReq = z.infer<typeof GetTopicReq>

export async function dumpTopic(topicId: string, options: GetTopicReq = {}): Promise<TopicData> {
  const { lastMessageId, visibleToUserId, beforeRawTs } = options

  const [topic] = await db
    .select()
    .from(topicTable)
    .where(eq(topicTable.id, topicId))
    .limit(1)

  if (!topic) {
    throw new Error(`Topic with id ${topicId} not found`)
  }

  // Build the messages query with optional channel filtering
  let messages: SlackMessage[]

  if (visibleToUserId) {
    // If visibleToUserId is provided, join with slackChannelTable and filter
    const messagesResult = await db
      .select({ message: slackMessageTable })
      .from(slackMessageTable)
      .leftJoin(slackChannelTable, eq(slackMessageTable.channelId, slackChannelTable.id))
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
    // Filter to only include messages up to and including the target message's timestamp
    messages = messages.filter((msg) =>
      Number(msg.rawTs) <= Number(targetMessage.rawTs),
    )
  }

  // If beforeRawTs is provided, filter messages before that raw timestamp
  if (beforeRawTs) {
    messages = messages.filter((msg) =>
      Number(msg.rawTs) < Number(beforeRawTs),
    )
  }

  // Fetch users that are referenced in the topic
  const users = topic.userIds.length > 0
    ? await db
        .select()
        .from(slackUserTable)
        .where(inArray(slackUserTable.id, topic.userIds))
    : []

  // Fetch userData for users referenced in the topic
  const userData = topic.userIds.length > 0
    ? await db
        .select()
        .from(userDataTable)
        .where(inArray(userDataTable.slackUserId, topic.userIds))
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
    topic: topic,
    messages,
    users,
    userData,
    channels,
  }

  return result
}

export async function loadTopics(jsonData: string): Promise<{ topicIds: string[] }> {
  // Parse string input if needed
  const parsedData = JSON.parse(jsonData) as TopicRes | TopicRes[]

  // Normalize to array with Date objects
  const topicReqsArray: TopicRes[] = Array.isArray(parsedData) ? parsedData : [parsedData]
  const topicsArray: TopicData[] = topicReqsArray.map((topicRes) => unserializeTopicTimestamps(topicRes))

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

    // Insert messages with new topic ID
    if (data.messages.length > 0) {
      const messagesWithNewTopicId = data.messages.map((msg) => {
        const msgData: SlackMessageInsert = { ...msg }
        delete msgData.id
        return {
          ...msgData,
          topicId: insertedTopic.id,
        }
      })

      await db.insert(slackMessageTable).values(messagesWithNewTopicId)
    }

    topicIds.push(insertedTopic.id)
  }

  return { topicIds }
}

export function replaceUserMentions(text: string, userMap: Map<string, string>): string {
  if (!userMap || userMap.size === 0) {
    return text
  }
  // Replace all <@USERID> patterns with the user's name
  return text.replace(/<@([A-Z0-9]+)>/g, (match, userId: string) => {
    const userName = userMap.get(userId)
    return userName ? `<@${userName}>` : match
  })
}

export function organizeMessagesByChannelAndThread(messages: SlackMessage[], userMap: Map<string, string>, showMessageIds = false): string {
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

  // Sort messages within each group by timestamp and format output
  let output = ''
  Object.entries(messageGroups).forEach(([channelId, threads]) => {
    output += `Channel ${channelId}:\n`

    // Sort threads by threadId converted to number
    const sortedThreads = Object.entries(threads).sort(([aId], [bId]) => {
      return Number(aId) - Number(bId)
    })

    sortedThreads.forEach(([threadId, messages]) => {
      // Only show thread header if there's more than one message in the thread
      if (messages.length > 1) {
        // Convert threadId (timestamp string) to formatted date
        output += `  Thread [${tsToDate(threadId).toLocaleString()}]:\n`
      }

      // Sort messages by timestamp
      const sortedMessages = messages.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )

      sortedMessages.forEach((msg) => {
        // Adjust indent based on whether we're showing thread header
        const indent = messages.length > 1 ? '    ' : '  '
        const userName = userMap?.get(msg.userId) || 'Unknown User'
        const processedText = replaceUserMentions(msg.text, userMap)
        const messageIdPrefix = showMessageIds ? `(${msg.id}) ` : ''
        output += `${indent}${messageIdPrefix}[${new Date(msg.timestamp).toLocaleString()}] ${userName}: "${processedText}"\n`
      })
    })
    output += '\n'
  })

  return output.trim()
}

export async function showTopic(topicId: string, options: GetTopicReq = {}): Promise<void> {
  // Use dumpTopic to get all the data
  const topicData = await dumpTopic(topicId, options)

  // Build user map from all users in the database for message formatting
  const allUsers = await db.select().from(slackUserTable)
  const userMap = new Map<string, string>()
  for (const user of allUsers) {
    const name = user.realName || user.id
    userMap.set(user.id, name)
  }

  const output = `Topic:
ID: ${topicData.topic.id}
Summary: ${topicData.topic.summary}
Users involved: ${topicData.topic.userIds.map((id) => {
  const name = userMap.get(id)
  return name || 'Unknown User'
}).join(', ')}
Created: ${new Date(topicData.topic.createdAt).toLocaleString()}
Last updated: ${new Date(topicData.topic.updatedAt).toLocaleString()}

Messages in this Topic:
${organizeMessagesByChannelAndThread(topicData.messages, userMap, true)}`

  console.log(output)
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
    console.log('  tsx src/utils.ts show <topicId> [messageId]')
    console.log('  tsx src/utils.ts dump <topicId> [messageId] [-o outputFile]')
    console.log('  tsx src/utils.ts load <jsonFile>')
    console.log('\nOptions:')
    console.log('  -h, --help     Show this help message')
    console.log('  -o, --output   Output file for dump command')
    process.exit(0)
  }

  if (command === 'show') {
    const topicId = positionals[1]
    if (!topicId) {
      console.error('Error: topicId is required for show command')
      console.error('Usage: tsx src/utils.ts show <topicId> [messageId]')
      process.exit(1)
    }

    const messageId = positionals[2]
    await showTopic(topicId, { lastMessageId: messageId })
  } else if (command === 'dump') {
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
      await fs.writeFile(values.output, jsonData)
      console.log(`Topic data written to ${values.output}`)
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

    const jsonData = await fs.readFile(jsonFile, 'utf-8')
    const result = await loadTopics(jsonData)
    if (result.topicIds.length === 1) {
      console.log(`Topic loaded with new ID: ${result.topicIds[0]}`)
    } else {
      console.log(`${result.topicIds.length} topics loaded with IDs: ${result.topicIds.join(', ')}`)
    }

  } else {
    console.error(`Error: Unknown command '${command}'`)
    console.log('Usage:')
    console.log('  tsx src/utils.ts show <topicId> [messageId]')
    console.log('  tsx src/utils.ts dump <topicId> [messageId] [-o outputFile]')
    console.log('  tsx src/utils.ts load <jsonFile>')
    process.exit(1)
  }

  // Clean up db connection for quicker exit
  process.exit(0)
}
