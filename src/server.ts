// Load environment variables from .env early (no external deps)
import './load-env'

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'

import { connectSlackClient } from './slack-bot.ts'
import { upsertFakeUser, mockSlackClient, BOT_USER_ID } from './local-helpers.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback, generateBotAuthUrl } from './calendar-service'
import { startAutoMessageCron } from './utils'
import { localRoutes } from './routes/local'

function isLocalEnv() {
  return process.env.PV_NODE_ENV === 'local'
}

const PORT = isLocalEnv() ? 3001 : 3009
const slackClient = isLocalEnv() ? mockSlackClient : await connectSlackClient()

// Insert bot user if it doesn't exist
if (isLocalEnv()) {
  await upsertFakeUser({ id: BOT_USER_ID, realName: 'Pivotal', isBot: true })
}

const honoApp = new Hono()
  .use(logger((message) => {
    const logEntry = `[${new Date().toISOString()}] ${message}`
    console.log(logEntry)
  }))

  .get('/healthcheck', (c) => {
    return c.text('okay')
  })

  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    return handleGoogleAuthCallback(c, c.req.valid('query'), slackClient)
  })

  // One-time admin route to authorize the bot calendar (grabs refresh token)
  .get('/admin/google/bot/connect', (c) => {
    const url = generateBotAuthUrl()
    return c.redirect(url)
  })

  // Only serve local_api if we're running the server locally
  .route('/local_api', isLocalEnv() ? localRoutes : new Hono())

export type AppType = typeof honoApp

serve({ fetch: honoApp.fetch, port: PORT })
startAutoMessageCron(slackClient)
console.log(`Webserver running on port ${PORT}...`)
