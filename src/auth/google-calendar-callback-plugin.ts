import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import { eq, and } from 'drizzle-orm'
import db from '../db/engine'
import { memberTable, organizationTable, accountTable } from '../db/schema/auth'
import { getTopics } from '../utils'
import { getSlackClient } from '../integrations/slack'

export function googleCalendarCallbackPlugin() {
  return {
    id: 'google-calendar-callback-plugin',
    hooks: {
      after: [{
        matcher: (c) => c.path === '/callback/:id' && c.params?.id === 'google',
        handler: createAuthMiddleware(async (c) => {
          /*
          ** Check that the logged-in user's slack team matches the 'team' url param, if it exists
          */

          // Get the team param from the url we're redirecting to
          const callbackURL = c.context.responseHeaders?.get('location') || ''
          const url = new URL(callbackURL, c.context.baseURL)
          const teamFromCallback = url.searchParams.get('team')

          if (!teamFromCallback) {
            // No team verification needed - user accessed directly from profile page
            return
          }

          // Get current user session
          const session = await getSessionFromCtx(c)
          if (!session?.user) {
            c.context.logger.error('No user session found during Google callback')
            return
          }

          // Get user's organization
          const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
            .from(memberTable)
            .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
            .where(eq(memberTable.userId, session.user.id))
            .limit(1)

          if (!userOrg) {
            c.context.logger.error('User has no organization in Google callback')
            return
          }

          if (userOrg.slackTeamId !== teamFromCallback) {
            c.context.logger.error(`Team ID mismatch: expected ${teamFromCallback}, got ${userOrg.slackTeamId}`)
            return c.redirect('/profile?error=team-mismatch')
          }

          // Team matches - proceed normally
          c.context.logger.info(`Team verification successful for user ${session.user.id}`)

          /*
          ** Clear buttons from the slack messages requesting the user's calendar connection
          */

          const slackClient = await getSlackClient(session.user.id)
          if (!slackClient) {
            c.context.logger.warn('No Slack app installation found; cannot clear calendar prompts')
            return
          }

          const [slackAccount] = await db.select()
            .from(accountTable)
            .where(and(
              eq(accountTable.userId, session.user.id),
              eq(accountTable.teamId, userOrg.slackTeamId),
            ))
          if (!slackAccount) {
            c.context.logger.warn(`Slack account with teamId ${userOrg.slackTeamId} not found`)
            return
          }

          const topics = await getTopics(userOrg.slackTeamId, null, true)
          for (const topic of topics) {
            const pointer = topic.state.perUserContext[slackAccount.accountId]?.calendarPromptMessage
            if (!pointer) continue

            try {
              await slackClient.chat.update({
                channel: pointer.channelId,
                ts: pointer.ts,
                text: '✅ Calendar connected. All set!',
                blocks: [],
              })
            } catch (updateError) {
              c.context.logger.warn(
                `Failed to clear calendar prompt buttons for user ${slackAccount.accountId} in channel ${pointer.channelId}`,
                updateError,
              )
            }
          }
        }),
      }],
    },
  } satisfies BetterAuthPlugin
}
