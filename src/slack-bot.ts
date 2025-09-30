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
  slackApp.action('dont_ask_calendar_again', async ({ ack, body, respond, client }) => {
    try {
      // Acknowledge the button action (must be within 3s)
      await ack()

      // Extract user ID from the action
      const userId = body.user.id

      // Set the suppression flag
      await setSuppressCalendarPrompt(userId, true)

      // Send ephemeral confirmation message to the user who clicked
      await respond({
        text: "Okay, I won't ask again. If you change your mind, just let me know.",
        response_type: 'ephemeral',
      })

      // Remove buttons from the original message
      try {
        type ActionBodyLike = {
          channel?: { id?: string }
          container?: { channel_id?: string, message_ts?: string }
          message?: { ts?: string, text?: string }
        }
        const a = body as unknown as ActionBodyLike
        const channelId = a.channel?.id || a.container?.channel_id
        const ts = a.message?.ts || a.container?.message_ts
        if (channelId && ts) {
          await client.chat.update({
            channel: channelId,
            ts,
            text: "Okay, I won't ask again. If you change your mind, just let me know.",
            blocks: [],
          })
        }
      } catch (e) {
        console.warn('Failed to clear buttons after dont_ask_calendar_again:', e)
      }

      console.log(`User ${userId} opted out of calendar prompts`)
    } catch (error) {
      console.error('Error handling dont_ask_calendar_again action:', error)
      await ack() // Fallback empty ack on error
    }
  })

  // Handle "Not now" button - simple dismiss action
  slackApp.action('calendar_not_now', async ({ ack, body, client }) => {
    await ack()
    // Remove buttons to make the action transactional
    try {
      type ActionBodyLike = {
        channel?: { id?: string }
        container?: { channel_id?: string, message_ts?: string }
        message?: { ts?: string, text?: string }
      }
      const a = body as unknown as ActionBodyLike
      const channelId = a.channel?.id || a.container?.channel_id
      const ts = a.message?.ts || a.container?.message_ts
      if (channelId && ts) {
        await client.chat.update({
          channel: channelId,
          ts,
          text: "Got it – I'll hold off on connecting your calendar for now. If you change your mind, just let me know and I'll resend the calendar link.",
          blocks: [],
        })
      }
    } catch (e) {
      console.warn('Failed to clear buttons after calendar_not_now:', e)
    }
  })

  await slackApp.start()
  slackApp.logger.info('Slack bot is running')

  return slackApp.client
}
