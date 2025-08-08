const { App } = await import('@slack/bolt')
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { Server } from 'socket.io'
import { parseArgs } from 'node:util'

import { handleSlackMessage } from './slack-message-handler'
import { setupSocketServer } from './flack-socket-server.ts'
import { exchangeCodeForTokens, saveUserTokens } from './google-oauth'
import { fetchAndStoreUserCalendar } from './calendar-service'

const args = parseArgs({ options: { prod: { type: 'boolean' } } })

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

// Only listen for real slack messages if --prod flag is present
if (args.values.prod) {
  slackApp.message(async ({ message, context, client }) => {
    await handleSlackMessage(message, context.botUserId, client)
  })
}

await initializeSlackApp()

// Only run the flack socket server if --prod flag is not present
if (!args.values.prod) {
  const PORT = 3001
  const honoApp = new Hono()

  // Google OAuth callback route
  honoApp.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const error = c.req.query('error')

    if (error) {
      console.error('OAuth error:', error)
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>Error: ${error}</p>
            <p>You can close this window and try again in Slack.</p>
          </body>
        </html>
      `)
    }

    if (!code || !state) {
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>Missing required parameters. Please try again.</p>
          </body>
        </html>
      `)
    }

    try {
      // Parse state to get Slack user info: "slack:U123ABC:T456DEF"
      const [prefix, slackUserId, slackTeamId] = state.split(':')

      if (prefix !== 'slack' || !slackUserId || !slackTeamId) {
        throw new Error('Invalid state parameter')
      }

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code)

      // Get user info from Slack to save names
      try {
        const userInfo = await slackApp.client.users.info({ user: slackUserId })
        const user = userInfo.user

        // user.display_name lives under profile
        await saveUserTokens(
          slackUserId,
          slackTeamId,
          tokens,
          user?.name,
          user?.real_name || user?.profile?.display_name,
        )
      } catch (slackError) {
        console.warn('Could not get Slack user info:', slackError)
        // Save tokens without user names
        await saveUserTokens(slackUserId, slackTeamId, tokens)
      }

      // Fetch and store calendar events immediately after saving tokens
      try {
        await fetchAndStoreUserCalendar(slackUserId)
        console.log(`Successfully fetched calendar for user ${slackUserId}`)
      } catch (calendarError) {
        console.error('Error fetching calendar after OAuth:', calendarError)
      }

      // Send success message to user in Slack
      try {
        await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: `✅ Your Google Calendar has been successfully connected! I can now check your availability when scheduling meetings.`,
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

  const server = serve({ fetch: honoApp.fetch, port: PORT })
  const io = new Server(server, { connectionStateRecovery: {} })
  setupSocketServer(io, botUserId!, slackApp.client)
  console.log(`Socket server running on port ${PORT}...`)
}

export {}
