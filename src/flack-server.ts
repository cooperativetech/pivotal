import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Server } from 'socket.io'
import { desc } from 'drizzle-orm'
import { z } from 'zod'

import { setupSocketServer, FlackSlackClient } from './flack-socket-server.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'
import db from './db/engine'
import { topicTable, Topic } from './db/schema/main'
import { cleanupTestData } from './db/cleanup'
import { GetTopicReq, dumpTopic } from './utils'
import { scheduleNextStep } from './anthropic-api'

const PORT = 3001
const honoApp = new Hono()
  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    return handleGoogleAuthCallback(c, c.req.valid('query'), slackClient)
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

  .get('/api/latest_topic_id', async (c) => {
    try {
      // Get the most recently created topic
      const [latestTopic] = await db
        .select()
        .from(topicTable)
        .orderBy(desc(topicTable.updatedAt))
        .limit(1)

      if (!latestTopic) {
        return c.json({ error: 'No topics found' }, 404)
      }

      return c.json({ topicId: latestTopic.id })
    } catch (error) {
      console.error('Error fetching latest topic:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .post('/api/clear_test_data', async (c) => {
    await slackClient.clearTestData()
    const result = await cleanupTestData()
    return c.json({
      success: result.success,
      message: `Cleared all topics and messages from database (method: ${result.method})`,
    })
  })

  .post('/api/users/create_fake', zValidator('json', z.strictObject({
    userId: z.string(),
    realName: z.string(),
  })), (c) => {
    const body = c.req.valid('json')
    slackClient.createFakeUser(body.userId, body.realName)
    return c.json({ success: true, message: `Created fake user ${body.userId}` })
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

      // Find bot userId by looking for userIds in previousMessages that are not in topic.userIds
      const topicUserIds = new Set(topicData.topic.userIds)
      const botUserIds = new Set<string>()
      const slackUserIds = new Set<string>()
      const slackChannelIds = new Set<string>()

      previousMessages.forEach((msg) => {
        slackChannelIds.add(msg.channelId)
        if (!topicUserIds.has(msg.userId)) {
          botUserIds.add(msg.userId)
        } else {
          slackUserIds.add(msg.userId)
        }
      })

      // If we have channels, add all users in currently open channels as well
      if (topicData.channels) {
        for (const channel of topicData.channels) {
          if (!slackChannelIds.has(channel.id)) {
            continue
          }
          for (const userId of channel.userIds) {
            if (!botUserIds.has(userId)) {
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

      if (botUserIds.size > 1) {
        throw new Error(`Expected zero or one bot userId, found ${botUserIds.size}: ${Array.from(botUserIds).join(', ')}`)
      }
      const botUserId = Array.from(botUserIds)[0] || 'UNKNOWN'

      // Create user map
      const userMap = new Map<string, string>()
      topicData.users.forEach((user) => {
        userMap.set(user.id, user.realName || user.id)
      })

      // Set the bot userId to "Pivotal" in the userMap
      userMap.set(botUserId, 'Pivotal')

      // Call scheduleNextStep
      const result = await scheduleNextStep(
        message,
        topicWithCurrentUsers,
        previousMessages,
        userMap,
        botUserId,
      )

      return c.json(result)
    } catch (error) {
      console.error('Error testing LLM response:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500)
    }
  })

export type AppType = typeof honoApp

const server = serve({ fetch: honoApp.fetch, port: PORT })
const io = new Server(server, { connectionStateRecovery: {} })
const slackClient: FlackSlackClient = setupSocketServer(io)
console.log(`Flack webserver running on port ${PORT}...`)
