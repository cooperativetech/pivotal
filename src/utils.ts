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
  Topic,
  TopicInsert,
  slackUserTable,
  SlackUser,
  SlackUserInsert,
  slackChannelTable,
} from './db/schema/main'

export function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000)
}

export interface TopicData {
  topic: Topic
  messages: SlackMessage[]
  users: SlackUser[]
}

export const GetTopicReq = z.strictObject({
  lastMessageId: z.string().optional(),
  visibleToUserId: z.string().optional(),
})
export type GetTopicReq = z.infer<typeof GetTopicReq>

export async function dumpTopic(topicId: string, options: GetTopicReq = {}): Promise<TopicData> {
  const { lastMessageId, visibleToUserId } = options

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
      new Date(msg.timestamp).getTime() <= new Date(targetMessage.timestamp).getTime(),
    )
  }

  // Fetch users that are referenced in the topic
  const users = topic.userIds.length > 0
    ? await db
        .select()
        .from(slackUserTable)
        .where(inArray(slackUserTable.id, topic.userIds))
    : []

  const result: TopicData = {
    topic: topic,
    messages,
    users,
  }

  return result
}

export async function loadTopic(jsonData: string | TopicData): Promise<{ topicId: string }> {
  const data: TopicData = typeof jsonData === 'string' ? JSON.parse(jsonData) as TopicData : jsonData

  // Insert or update users
  if (data.users && data.users.length > 0) {
    for (const user of data.users) {
      const userData: SlackUserInsert = { ...user }
      await db
        .insert(slackUserTable)
        .values(userData)
        .onConflictDoUpdate({
          target: slackUserTable.id,
          set: {
            teamId: userData.teamId,
            realName: userData.realName,
            tz: userData.tz,
            isBot: userData.isBot,
            deleted: userData.deleted,
            updated: userData.updated,
            raw: userData.raw,
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

  return { topicId: insertedTopic.id }
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
    const result = await loadTopic(jsonData)
    console.log(`Topic loaded with new ID: ${result.topicId}`)

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
