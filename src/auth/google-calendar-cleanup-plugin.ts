import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import { WebClient } from '@slack/web-api'
import { clearCalendarPromptMessages } from '../calendar-service'

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

            const slackBotToken = process.env.PV_SLACK_BOT_TOKEN
            if (!slackBotToken) {
              c.context.logger.warn('PV_SLACK_BOT_TOKEN missing; cannot clear calendar prompts')
              return
            }

            const accounts = await c.context.internalAdapter.findAccounts(session.user.id)
            const slackAccount = accounts.find((account) => account.providerId === 'slack')
            if (!slackAccount?.accountId) {
              c.context.logger.warn('No linked Slack account found; skipping calendar prompt cleanup')
              return
            }

            const slackClient = new WebClient(slackBotToken)
            await clearCalendarPromptMessages(slackAccount.accountId, slackClient)
          } catch (error) {
            c.context.logger.error('Failed to clear calendar prompt buttons after Google callback', error)
          }
        }),
      }],
    },
  } satisfies BetterAuthPlugin
}
