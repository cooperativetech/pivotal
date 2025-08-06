const { App } = await import('@slack/bolt')
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Server } from 'socket.io'
import { parseArgs } from 'node:util'

import { handleSlackMessage } from './slack-message-handler'
import { setupSocketServer } from './flack-socket-server.ts'

const args = parseArgs({ options: { dev: { type: 'boolean' } } })

// Store bot user ID after initialization
let botUserId: string | undefined

const slackApp = new App({
  token: process.env.PV_SLACK_BOT_TOKEN,
  appToken: process.env.PV_SLACK_APP_TOKEN,
  socketMode: true,
})

async function initializeSlackApp() {
  await slackApp.start()
  const authResult = await slackApp.client.auth.test()
  botUserId = authResult.user_id
  slackApp.logger.info('Slack bot is running')
}

slackApp.message(async ({ message, context, client }) => {
  await handleSlackMessage(message, context.botUserId, client)
})

await initializeSlackApp()

// Only run the flack socket server if --dev flag is present
if (args.values.dev) {
  const PORT = 3001
  const honoApp = new Hono()
  const server = serve({ fetch: honoApp.fetch, port: PORT })
  const io = new Server(server, { connectionStateRecovery: {} })
  setupSocketServer(io, botUserId!, slackApp.client)
  console.log(`Socket server running on port ${PORT}...`)
}

export {}
