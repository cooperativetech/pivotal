import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'

import db from '../db/engine'
import type { SlackUser } from '../db/schema/main'
import { slackChannelTable, slackUserTable, userDataTable } from '../db/schema/main'
import type { TopicWithState } from '@shared/api-types'
import { upsertFakeUser, getOrCreateChannelForUsers, cleanupTestData, mockSlackClient, BOT_USER_ID } from '../local-helpers.ts'
import type { SlackAPIMessage } from '../slack-message-handler'
import { messageProcessingLock, handleSlackMessage } from '../slack-message-handler'
import { GetTopicReq, dumpTopic, getTopicWithState, getTopics } from '../utils'
import { workflowAgentMap, runConversationAgent } from '../agents'
import { createCalendarInviteFromBot, tryRescheduleTaggedEvent, setSuppressCalendarPrompt } from '../calendar-service'
import { getGoogleCalendar } from '../integrations/google'
import type { CalendarEvent } from '@shared/api-types'

export const localRoutes = new Hono()
  .get('/topics/:topicId', zValidator('query', GetTopicReq), async (c) => {
    const topicId = c.req.param('topicId')

    try {
      const topicData = await dumpTopic(topicId, c.req.valid('query'))

      const now = new Date()
      const nowPlusOneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      const userCalendarArray = await Promise.all(topicData.users.map(
        (user) => getGoogleCalendar(user.id, now, nowPlusOneWeek),
      ))
      const userCalendars: Record<string, CalendarEvent[] | null> = {}
      topicData.users.forEach((user, index) => userCalendars[user.id] = userCalendarArray[index])

      return c.json({
        topicData,
        userCalendars,
      })
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

  .get('/topics', async (c) => {
    try {
      const topics = await getTopics()
      return c.json({ topics })
    } catch (error) {
      console.error('Error fetching topics:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/users', async (c) => {
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

      // Add next week's calendar for any users that have one
      const now = new Date()
      const nowPlusOneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      const usersWithCalendars = await Promise.all(users.map(async (user) => {
        return {
          ...user,
          calendar: await getGoogleCalendar(user.id, now, nowPlusOneWeek),
        }
      }))

      return c.json({ users: usersWithCalendars })
    } catch (error) {
      console.error('Error fetching users:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .post('/clear_test_data', async (c) => {
    await messageProcessingLock.clear()
    const result = await cleanupTestData()
    return c.json({
      sccess: result.success,
      message: `Cleared all topics and messages from database (method: ${result.method})`,
    })
  })

  // Mock: "Don't ask again" to suppress prompts
  .post('/calendar/dont_ask_again', zValidator('json', z.strictObject({
    userId: z.string(),
  })), async (c) => {
    const { userId } = c.req.valid('json')
    try {
      await setSuppressCalendarPrompt(userId, true)
      return c.json({ success: true })
    } catch (error) {
      console.error('Error in dont_ask_again:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .post('/users/create_fake', zValidator('json', z.strictObject({
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

  .post('/test_llm_response', zValidator('json', z.strictObject({
    topicId: z.string(),
    messageId: z.string(),
  })), async (c) => {
    const { topicId, messageId } = c.req.valid('json')

    try {
      // Get the topic data
      const topicData = await dumpTopic(topicId, { lastMessageId: messageId })

      // Set the topic state to the latest one
      const topicWithState = {
        ...topicData.topic,
        state:  topicData.states[topicData.states.length - 1],
      }

      // Find the specific message, which should be the last one in the list
      const message = topicData.messages[topicData.messages.length - 1]
      if (!message || message.id !== messageId) {
        throw new Error(`Message ${messageId} not found at end of subset topic ${topicId}`)
      }
      const previousMessages = topicData.messages.slice(0, -1)

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
        topicWithState,
        previousMessages,
        userMap,
      )

      return c.json(result)
    } catch (error) {
      console.error('Error testing LLM response:', error)
      return c.json({ error: error instanceof Error ? error.message : 'Internal server error' }, 500)
    }
  })

  .post('/message', zValidator('json', z.strictObject({
    userId: z.string(),
    text: z.string(),
    topicId: z.string().optional(),
    ignoreExistingTopics: z.boolean().optional(),
  })), async (c) => {
    const { userId, text, topicId, ignoreExistingTopics = true } = c.req.valid('json')

    try {
      // Get botUserId from the topic if topicId is provided, otherwise use default
      let botUserId = BOT_USER_ID
      if (topicId) {
        const topic = await getTopicWithState(topicId)
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
        ignoreExistingTopics,
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

  // Create a test Meet link using the bot calendar (no emails sent)
  .post('/test_meet', zValidator('json', z.strictObject({
    start: z.string(),
    end: z.string(),
    summary: z.string().optional(),
    userIds: z.array(z.string()).optional(),
  })), async (c) => {
    const { start, end, summary, userIds } = c.req.valid('json')
    try {
      // Minimal TopicWithState mock for local testing
      const fakeTopic: TopicWithState = {
        id: `test-${Date.now()}`,
        botUserId: BOT_USER_ID,
        workflowType: 'scheduling',
        createdAt: new Date(),
        state: {
          id: `state-${Date.now()}`,
          topicId: `test-${Date.now()}`,
          userIds: userIds || [],
          summary: summary || 'Test Meeting',
          isActive: true,
          perUserContext: {},
          createdByMessageId: '00000000-0000-0000-0000-000000000000',
          createdAt: new Date(),
        },
      }

      const result = await createCalendarInviteFromBot(fakeTopic, {
        start,
        end,
        summary,
      })

      if (!result) {
        return c.json({ error: 'Failed to create bot event. Ensure service account env vars (PV_GOOGLE_SERVICE_ACCOUNT_EMAIL / PV_GOOGLE_SERVICE_ACCOUNT_KEY / PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT) are configured correctly.' }, 500)
      }
      return c.json(result)
    } catch (error) {
      console.error('Error creating test Meet:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  // Reschedule the most recent event for a topic (bot calendar)
  .post('/topics/:topicId/reschedule', zValidator('json', z.strictObject({
    start: z.string(),
    end: z.string(),
  })), async (c) => {
    const { topicId } = c.req.param()
    const { start, end } = c.req.valid('json')
    try {
      const result = await tryRescheduleTaggedEvent(topicId, start, end)
      if (!result.success) {
        return c.json({ error: 'Failed to reschedule event' }, 500)
      }
      return c.json(result)
    } catch (error) {
      console.error('Error in reschedule endpoint:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/channels/:channelId', async (c) => {
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
