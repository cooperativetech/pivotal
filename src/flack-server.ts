import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Server } from 'socket.io'
import { eq } from 'drizzle-orm'

import { setupSocketServer } from './flack-socket-server.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'
import db from './db/engine'
import { topicTable, slackMessageTable } from './db/schema/main'
import { cleanupTestData } from './db/cleanup'
import { GetTopicReq, dumpTopic } from './utils'

const PORT = 3001
const honoApp = new Hono()
  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    return handleGoogleAuthCallback(c, c.req.valid('query'), slackClient)
  })

  .get('/api/topic/:topicId', zValidator('query', GetTopicReq), async (c) => {
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

  .post('/api/clear-topics', async (c) => {
    // Clear topics for eval testing
    const body: { summary?: string; clearAll?: boolean } = await c.req.json()

    if (body.clearAll) {
      const result = await cleanupTestData()
      return c.json({
        success: result.success,
        message: `Cleared all topics and messages from database (method: ${result.method})`,
      })
    } else if (body.summary) {
      // Clear specific topic by summary
      const topics = await db.select().from(topicTable).where(eq(topicTable.summary, body.summary))
      for (const topic of topics) {
        // Delete messages for this topic first
        await db.delete(slackMessageTable).where(eq(slackMessageTable.topicId, topic.id))
        // Then delete the topic
        await db.delete(topicTable).where(eq(topicTable.id, topic.id))
      }
      return c.json({ success: true, message: `Cleared topics with summary: ${body.summary}` })
    }
    return c.json({ success: false, message: 'No summary provided' })
  })

const server = serve({ fetch: honoApp.fetch, port: PORT })
const io = new Server(server, { connectionStateRecovery: {} })
const slackClient = setupSocketServer(io)
console.log(`Flack webserver running on port ${PORT}...`)
