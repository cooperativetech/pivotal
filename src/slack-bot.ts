// @slack/bolt requires this import syntax for some reason
const { App } = await import('@slack/bolt')
import type { WebClient } from '@slack/web-api'

import { handleSlackMessage } from './slack-message-handler'
import { setSuppressCalendarPrompt } from './calendar-service'

export async function connectSlackClient(): Promise<WebClient> {
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

  // Handle interactive components (buttons)
  slackApp.action('dont_ask_calendar_again', async ({ ack, body, respond }) => {
    try {
      // Acknowledge the button action (must be within 3s)
      await ack()

      // Extract user ID from the action
      const userId = body.user.id

      // Set the suppression flag
      await setSuppressCalendarPrompt(userId, true)

      // Send ephemeral confirmation message to the user who clicked
      await respond({
        text: '✅ Got it! I won\'t ask you to connect your calendar again unless you explicitly ask me to.',
        response_type: 'ephemeral',
      })

      console.log(`User ${userId} opted out of calendar prompts`)
    } catch (error) {
      console.error('Error handling dont_ask_calendar_again action:', error)
      await ack() // Fallback empty ack on error
    }
  })

  // Handle "Not now" button - simple dismiss action
  slackApp.action('calendar_not_now', async ({ ack }) => {
    await ack()
    // Just acknowledge the action - message will be dismissed automatically
    // User won't see buttons again in this topic (already tracked by addPromptedUser)
  })

  // Note: "Connect Google Calendar" button is now a direct URL link, no action handler needed

  await slackApp.start()
  slackApp.logger.info('Slack bot is running')

  return slackApp.client
}
