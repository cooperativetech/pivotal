import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import db from '../db/engine'
import { slackUserTable } from '../db/schema/main'
import { getTopics } from '../utils'
import { getSlackClient } from '../integrations/slack'

export function googleCalendarCleanupPlugin() {
  return {
    id: 'google-calendar-cleanup-plugin',
    hooks: {
      after: [{
        matcher: (c) => c.path === '/callback/:id' && c.params?.id === 'google',
        handler: createAuthMiddleware(async (c) => {
          try {
            const session = await getSessionFromCtx(c)
            if (!session?.user) {
              c.context.logger.error('No user session found after Google callback')
              return
            }

            const accounts = await c.context.internalAdapter.findAccounts(session.user.id)
            const slackAccount = accounts.find((account) => account.providerId === 'slack')
            if (!slackAccount?.accountId) {
              c.context.logger.warn('No linked Slack account found; skipping calendar prompt cleanup')
              return
            }

            const slackClient = await getSlackClient(session.user.id)
            if (!slackClient) {
              c.context.logger.warn('No Slack app installation found; cannot clear calendar prompts')
              return
            }

            const slackUserId = slackAccount.accountId

            // Get the user's teamId from slackUserTable
            const [slackUser] = await db.select()
              .from(slackUserTable)
              .where(eq(slackUserTable.id, slackUserId))

            if (!slackUser) {
              c.context.logger.warn(`User ${slackUserId} not found in slackUserTable`)
              return
            }

            const topics = await getTopics(slackUser.teamId, null, true)
            for (const topic of topics) {
              const pointer = topic.state.perUserContext[slackUserId]?.calendarPromptMessage
              if (!pointer) continue

              try {
                await slackClient.chat.update({
                  channel: pointer.channelId,
                  ts: pointer.ts,
                  text: '✅ Calendar connected. All set!',
                  blocks: [],
                })
              } catch (updateError) {
                c.context.logger.warn(`Failed to clear calendar prompt buttons for user ${slackUserId} in channel ${pointer.channelId}`, updateError)
              }
            }
          } catch (error) {
            c.context.logger.error('Failed to clear calendar prompt buttons after Google callback', error)
          }
        }),
      }],
    },
  } satisfies BetterAuthPlugin
}
