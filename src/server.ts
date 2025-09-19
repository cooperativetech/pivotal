// Environment variables must be exported by the shell/CI; no .env loader

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { createServer } from 'node:https'
import { readFileSync } from 'fs'

import { connectSlackClient } from './slack-bot.ts'
import { upsertFakeUser, mockSlackClient, BOT_USER_ID } from './local-helpers.ts'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'
import { startAutoMessageCron } from './utils'
import { apiRoutes } from './routes/api'
import { localRoutes } from './routes/local'

function isLocalEnv() {
  return process.env.PV_NODE_ENV === 'local'
}

function isDevEnv() {
  return process.env.PV_NODE_ENV === 'dev'
}

const PORT = isLocalEnv() ? 3001 : 3009
const slackClient = isLocalEnv() ? mockSlackClient : await connectSlackClient()

// Insert bot user if it doesn't exist
if (isLocalEnv()) {
  await upsertFakeUser({ id: BOT_USER_ID, realName: 'Pivotal', isBot: true })
}

const app = new Hono()
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

  .route('/api', apiRoutes)

  // Only serve local_api if we're running the server locally
  .route('/local_api', isLocalEnv() ? localRoutes : new Hono())

export type AppType = typeof app

if (!isLocalEnv()) {
  app.get('/*', serveStatic({ root: './src/dist', index: 'index.html' }))
  app.get('*', serveStatic({ path: './src/dist/index.html' }))
}

if (isDevEnv()) {
  // Serve on https in dev env, so we can authenticate with slack
  serve({
    fetch: app.fetch,
    port: PORT,
    createServer: createServer,
    serverOptions: {
      cert: readFileSync('.cert/cert.pem'),
      key: readFileSync('.cert/key.pem'),
    },
  })

} else {
  // Serve on http in local env, since our SSL certificate is handled by vite
  // Serve on http in prod env, since our SSL certificate is handled by AWS
  serve({
    fetch: app.fetch,
    port: PORT,
  })
}

startAutoMessageCron(slackClient)
console.log(`Webserver running on port ${PORT}...`)
