import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Server } from 'socket.io'
import { desc } from 'drizzle-orm'
import { z } from 'zod'

import { setupSocketServer, FlackSlackClient } from './flack-socket-server.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'
import db from './db/engine'
import { topicTable } from './db/schema/main'
import { cleanupTestData } from './db/cleanup'
import { GetTopicReq, dumpTopic } from './utils'

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

export type AppType = typeof honoApp

const server = serve({ fetch: honoApp.fetch, port: PORT })
const io = new Server(server, { connectionStateRecovery: {} })
const slackClient: FlackSlackClient = setupSocketServer(io)
console.log(`Flack webserver running on port ${PORT}...`)
