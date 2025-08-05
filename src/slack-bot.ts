const { App } = await import('@slack/bolt')
import { handleSlackMessage, getSlackUsers } from './slack-message-handler'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'

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

// Create Hono app for HTTP API for local testing
const honoApp = new Hono()
  .use('/*', cors())
  .get('/api/bot-info', (c) => {
    return c.json({ botUserId })
  })
  .get('/api/users', async (c) => {
    const users = await getSlackUsers(slackApp.client, false)
    // Convert Map to array of [id, name] pairs for JSON serialization
    return c.json(Array.from(users.entries()))
  })

serve({ fetch: honoApp.fetch, port: 3001 })
console.log(`HTTP API server running on port ${3001}...`)

export {}
