// @slack/bolt requires this import syntax for some reason
const { App } = await import('@slack/bolt')
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'

import { handleSlackMessage } from './slack-message-handler'
import { GoogleAuthCallbackReq, handleGoogleAuthCallback } from './calendar-service'

const slackApp = new App({
  token: process.env.PV_SLACK_BOT_TOKEN,
  appToken: process.env.PV_SLACK_APP_TOKEN,
  socketMode: true,
})

slackApp.message(async ({ message, context, client }) => {
  if (!context.botUserId) {
    throw new Error('Bot user id not found in context for message')
  }
  // Only handle GenericMessageEvent and BotMessageEvent for now
  if (message.subtype === undefined || message.subtype === 'bot_message') {
    await handleSlackMessage(message, context.botUserId, client)
  }
})

await slackApp.start()
slackApp.logger.info('Slack bot is running')

const PORT = 3009
const honoApp = new Hono()
  .get('/healthcheck', (c) => {
    return c.text('okay')
  })

  .get('/auth/google/callback', zValidator('query', GoogleAuthCallbackReq), async (c) => {
    return handleGoogleAuthCallback(c, c.req.valid('query'))
  })

serve({ fetch: honoApp.fetch, port: PORT })
console.log(`Prod webserver running on port ${PORT}...`)
