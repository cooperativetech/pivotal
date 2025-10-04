// @slack/bolt requires this import syntax for some reason
const { App } = await import('@slack/bolt')
import type { WebClient } from '@slack/web-api'
import { eq } from 'drizzle-orm'
import { symmetricDecrypt } from 'better-auth/crypto'

import { handleSlackMessage } from './slack-message-handler'
import { setSuppressCalendarPrompt } from './calendar-service'
import db from './db/engine'
import { slackAppInstallationTable } from './db/schema/auth'
import { SLACK_APP_SCOPES } from './auth'

export async function connectSlackClient(): Promise<WebClient> {
  const slackApp = new App({
    socketMode: true,
    appToken: process.env.PV_SLACK_APP_TOKEN,
    clientId: process.env.PV_SLACK_CLIENT_ID,
    clientSecret: process.env.PV_SLACK_CLIENT_SECRET,
    stateSecret: process.env.PV_BETTER_AUTH_SECRET,
    scopes: SLACK_APP_SCOPES,
    installationStore: {
      storeInstallation: async () => {}, // Unused since we handle auth ourselves
      fetchInstallation: async (installQuery) => {
        if (installQuery.isEnterpriseInstall && installQuery.enterpriseId) {
          throw new Error('Enterprise installations are not supported')
        }

        const teamId = installQuery.teamId
        if (!teamId) {
          throw new Error('Team ID is required for installation lookup')
        }

        // Query installation from database
        const [{ installation }] = await db.select()
          .from(slackAppInstallationTable)
          .where(eq(slackAppInstallationTable.teamId, teamId))
          .limit(1)

        if (!installation || !installation.bot) {
          throw new Error(`No valid installation found for team ${teamId}`)
        }

        installation.bot.token = await symmetricDecrypt({
          key: process.env.PV_BETTER_AUTH_SECRET!,
          data: installation.bot.token,
        })

        // Return Bolt-compatible installation object
        return installation
      },
    },
  })

  slackApp.message(async ({ message, context, client }) => {
    if (!context.botUserId) {
      throw new Error('Bot user id not found in context for message')
    }
    if (!context.teamId) {
      throw new Error('Team id not found in context for message')
    }
    // Only handle GenericMessageEvent and BotMessageEvent for now
    if (message.subtype === undefined || message.subtype === 'bot_message') {
      await handleSlackMessage(message, context.teamId, context.botUserId, client)
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
