// @slack/bolt requires this import syntax for some reason
const { App } = await import('@slack/bolt')
import type { AllMiddlewareArgs } from '@slack/bolt'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Server } from 'socket.io'
import { parseArgs } from 'node:util'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { handleSlackMessage } from './slack-message-handler'
import { setupSocketServer } from './flack-socket-server.ts'
import { fetchAndStoreGoogleAuthTokens, fetchAndStoreUserCalendar } from './calendar-service'
import db from './db/engine'
import { topicTable, slackMessageTable } from './db/schema/main'
import { cleanupTestData } from './db/cleanup'

const args = parseArgs({ options: { prod: { type: 'boolean' } } })

let slackClient: AllMiddlewareArgs['client']

// Only connect to real slack if --prod flag is present
if (args.values.prod) {
  const slackApp = new App({
    token: process.env.PV_SLACK_BOT_TOKEN,
    appToken: process.env.PV_SLACK_APP_TOKEN,
    socketMode: true,
  })

  slackApp.message(async ({ message, context, client }) => {
    await handleSlackMessage(message, context.botUserId, client)
  })

  await slackApp.start()
  slackClient = slackApp.client
  slackApp.logger.info('Slack bot is running')
}

const GoogleAuthCallbackReq = z.strictObject({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
  scope: z.string(),
})
type GoogleAuthCallbackReq = z.infer<typeof GoogleAuthCallbackReq>

const PORT = 3001
const honoApp = new Hono()
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

  // Google OAuth callback route
  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    const { code, state, error, error_description } = c.req.valid('query')

    if (error || !code) {
      console.error(`OAuth error: ${error} | ${error_description}`)
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>Error: ${error} | ${error_description}</p>
            <p>You can close this window and try again in Slack.</p>
          </body>
        </html>
      `)
    }

    try {
      const slackUserId = await fetchAndStoreGoogleAuthTokens(code, state)
      await fetchAndStoreUserCalendar(slackUserId)

      try {
        await slackClient.chat.postMessage({
          channel: slackUserId,
          text: '✅ Your Google Calendar has been successfully connected! I can now check your availability when scheduling meetings.'
  ,
        })
      } catch (slackError) {
        console.warn('Could not send success message to Slack:', slackError)
      }

      return c.html(`
        <html>
          <body>
            <h2>Calendar Connected Successfully!</h2>
            <p>Your Google Calendar has been connected to the scheduling bot.</p>
            <p>You can close this window and return to Slack.</p>
          </body>
        </html>
      `)

    } catch (tokenError) {
      console.error('Error processing OAuth callback:', tokenError)
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>There was an error connecting your calendar. Please try again.</p>
          </body>
        </html>
      `)
    }
  })

// Only run the flack socket server if --prod flag is not present
if (!args.values.prod) {
  const server = serve({ fetch: honoApp.fetch, port: PORT })
  const io = new Server(server, { connectionStateRecovery: {} })
  slackClient = setupSocketServer(io)
  console.log(`Socket server running on port ${PORT}...`)
}
