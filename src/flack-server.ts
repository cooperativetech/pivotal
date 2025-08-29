import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import db from './db/engine'
import type { Topic, SlackUser } from './db/schema/main'
import { topicTable, slackChannelTable, slackUserTable, userDataTable } from './db/schema/main'
import { upsertFakeUser, getOrCreateChannelForUsers, cleanupTestData, mockSlackClient, BOT_USER_ID } from './flack-helpers.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'
import type { SlackAPIMessage } from './slack-message-handler'
import { messageProcessingLock, handleSlackMessage } from './slack-message-handler'
import { GetTopicReq, dumpTopic, startAutoMessageCron } from './utils'
import { workflowAgentMap, runConversationAgent } from './agents'

const PORT = 3001
const honoApp = new Hono()
  .use(logger((message) => {
    const logEntry = `[${new Date().toISOString()}] ${message}`
    console.log(logEntry)
  }))

  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    return handleGoogleAuthCallback(c, c.req.valid('query'), mockSlackClient)
  })

  .get('/api/topics/:topicId', zValidator('query', GetTopicReq), async (c) => {
    const topicId = c.req.param('topicId')

    try {
      const topicData = await dumpTopic(topicId, c.req.valid('query'))
      return c.json(topicData)
    } catch (error) {
      console.error('Error fetching topic data:', error)
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          return c.json({ error: error.message }, 404)
        }
      }
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/api/topics', async (c) => {
    try {
      // Get all active topics, ordered by most recent first
      const topics = await db
        .select()
        .from(topicTable)
        .orderBy(desc(topicTable.updatedAt))

      return c.json({ topics })
    } catch (error) {
      console.error('Error fetching topics:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/api/users', async (c) => {
    try {
      // Get all non-bot users with their context
      const users = await db
        .select({
          id: slackUserTable.id,
          realName: slackUserTable.realName,
          tz: slackUserTable.tz,
          isBot: slackUserTable.isBot,
          context: userDataTable.context,
        })
        .from(slackUserTable)
        .leftJoin(userDataTable, eq(slackUserTable.id, userDataTable.slackUserId))
        .where(eq(slackUserTable.isBot, false))
        .orderBy(slackUserTable.updated)

      return c.json({ users })
    } catch (error) {
      console.error('Error fetching users:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .post('/api/clear_test_data', async (c) => {
    await messageProcessingLock.clear()
    const result = await cleanupTestData()
    return c.json({
      success: result.success,
      message: `Cleared all topics and messages from database (method: ${result.method})`,
    })
  })

  .post('/api/users/create_fake', zValidator('json', z.strictObject({
    users: z.array(z.object({
      id: z.string(),
      realName: z.string(),
      isBot: z.boolean().optional(),
      tz: z.string().optional(),
    })),
  })), async (c) => {
    const body = c.req.valid('json')
    const createdUsers = await Promise.all(body.users.map((user) => upsertFakeUser(user)))
    return c.json({
      success: true,
      message: `Created ${createdUsers.length} fake user(s)`,
      userIds: createdUsers.map((user) => user.id),
    })
  })

  .post('/api/test_llm_response', zValidator('json', z.strictObject({
    topicId: z.string(),
    messageId: z.string(),
  })), async (c) => {
    const { topicId, messageId } = c.req.valid('json')

    try {
      // Get the topic data
      const topicData = await dumpTopic(topicId, { lastMessageId: messageId })

      // Find the specific message, which should be the last one in the list
      const message = topicData.messages[topicData.messages.length - 1]
      if (!message || message.id !== messageId) {
        throw new Error(`Message ${messageId} not found at end of subset topic ${topicId}`)
      }
      const previousMessages = topicData.messages.slice(0, -1)

      const topicUserIds = new Set(topicData.topic.userIds)
      const slackUserIds = new Set<string>()
      const slackChannelIds = new Set<string>()

      previousMessages.forEach((msg) => {
        slackChannelIds.add(msg.channelId)
      })

      // Add all users in topicUserIds that are also in currently open channels
      if (topicData.channels) {
        for (const channel of topicData.channels) {
          if (!slackChannelIds.has(channel.id)) {
            continue
          }
          for (const userId of channel.userIds) {
            if (topicUserIds.has(userId)) {
              slackUserIds.add(userId)
            }
          }
        }
      }

      // Set topic to only have users it had at the time of this message
      const topicWithCurrentUsers: Topic = {
        ...topicData.topic,
        userIds: Array.from(slackUserIds),
      }

      // Create user map
      const userMap = new Map<string, SlackUser>()
      topicData.users.forEach((user) => {
        userMap.set(user.id, user)
      })

      // Set the bot userId in the userMap
      const [botUser] = await db
        .select()
        .from(slackUserTable)
        .where(eq(slackUserTable.id, topicData.topic.botUserId))
      userMap.set(topicData.topic.botUserId, botUser)

      const workflowAgent = workflowAgentMap.get(topicData.topic.workflowType)
      if (!workflowAgent) {
        throw new Error(`No agent found for workflow type: ${topicData.topic.workflowType}`)
      }

      // Call workflow agent
      const result = await runConversationAgent(
        workflowAgent,
        message,
        topicWithCurrentUsers,
        previousMessages,
        userMap,
      )

      return c.json(result)
    } catch (error) {
      console.error('Error testing LLM response:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500)
    }
  })

  .post('/api/message', zValidator('json', z.strictObject({
    userId: z.string(),
    text: z.string(),
    topicId: z.string().optional(),
  })), async (c) => {
    const { userId, text, topicId } = c.req.valid('json')

    try {
      // Get botUserId from the topic if topicId is provided, otherwise use default
      let botUserId = BOT_USER_ID
      if (topicId) {
        const [topic] = await db.select().from(topicTable).where(eq(topicTable.id, topicId))
        if (!topic) {
          throw new Error(`No topic found with id: ${topicId}`)
        }
        botUserId = topic.botUserId
      }

      const channelId = await getOrCreateChannelForUsers([userId])

      // Create a SlackAPIMessage
      const ts = (Date.now() / 1000).toString()
      const message: SlackAPIMessage = {
        type: 'message',
        subtype: undefined,
        text: text,
        ts: ts,
        user: userId,
        channel: channelId,
        channel_type: 'im',
        event_ts: ts,
      }

      const result = await handleSlackMessage(
        message,
        botUserId,
        mockSlackClient,
        topicId || null,
        true, // if topicId is null, create a new topic rather than routing to existing ones
      )
      if (!result) {
        throw new Error('Failed to process message')
      }

      return c.json(result)
    } catch (error) {
      console.error('Error processing message:', error)
      return c.json({
        error: error instanceof Error ? error.message : 'Internal server error',
      }, 500)
    }
  })

  .get('/api/channels/:channelId', async (c) => {
    const channelId = c.req.param('channelId')

    try {
      const [channel] = await db
        .select()
        .from(slackChannelTable)
        .where(eq(slackChannelTable.id, channelId))
      if (!channel) {
        return c.json({ error: `Channel not found: ${channelId}` }, 404)
      }

      return c.json(channel)
    } catch (error) {
      console.error('Error fetching channel:', error)
      return c.json({
        error: error instanceof Error ? error.message : 'Internal server error',
      }, 500)
    }
  })

export type AppType = typeof honoApp

// Insert bot user if it doesn't exist
await upsertFakeUser({ id: BOT_USER_ID, realName: 'Pivotal', isBot: true })

serve({ fetch: honoApp.fetch, port: PORT })
startAutoMessageCron(mockSlackClient)
console.log(`Flack webserver running on port ${PORT}...`)
