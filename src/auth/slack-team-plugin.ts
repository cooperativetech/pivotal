import { generateId } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import type { SlackProfile } from 'better-auth/social-providers'
import { decryptOAuthToken } from 'better-auth/oauth2'
import { eq, and, ne } from 'drizzle-orm'
import db from '../db/engine'
import { organizationTable, memberTable, accountTable } from '../db/schema/auth'
import { auth } from './index'

export function slackTeamPlugin() {
  return {
    id: 'slack-team-plugin',

    hooks: {
      after: [
        {
          // If team param was provided to sign-in/social, pass it through to OAuth URL
          matcher: (c) => {
            const provider = (c.body as { provider: string })?.provider
            return c.path === '/sign-in/social' && provider === 'slack'
          },
          handler: createAuthMiddleware(async (c) => { // eslint-disable-line @typescript-eslint/require-await
            const team = c.query?.team as string | undefined
            if (!team) {
              return
            }

            // Get the authorization URL from the response
            const res = c.context.returned as { url: string, redirect: boolean }
            if (!res.url) {
              return
            }

            // Append team parameter to the OAuth authorization URL
            const authUrl = new URL(res.url)
            authUrl.searchParams.set('team', team)

            // Update the return value with the modified URL
            res.url = authUrl.toString()
            return res
          }),
        },
        {
          // After slack login, assign the user to an organization based on the slack team id
          matcher: (c) => {
            return c.path === '/callback/:id' && c.params?.id === 'slack'
          },
          handler: createAuthMiddleware(async (c) => {
            const session = c.context.newSession
            if (!session) {
              c.context.logger.error('No new session found')
              return
            }
            const userId = session.user.id
            const sessionToken = session.session.token

            const slackProvider = c.context.socialProviders.find((p) => p.id === 'slack')
            if (!slackProvider) {
              c.context.logger.error('No Slack provider found')
              await c.context.internalAdapter.deleteSession(sessionToken)
              return
            }

            const accounts = await c.context.internalAdapter.findAccounts(userId)
            const slackAccounts = accounts.filter((account) => account.providerId === 'slack')
            if (slackAccounts.length === 0) {
              c.context.logger.error('No Slack account found for user')
              await c.context.internalAdapter.deleteSession(sessionToken)
              return
            } else if (slackAccounts.length > 1) {
              // We don't support multiple slack workspaces for a single user, so if the user
              // logs in with a different workspace than they did the first time, delete all but
              // their oldest slack account. The login still succeeds though
              const oldestAccountId = slackAccounts.reduce((oldest, account) => {
                return new Date(account.createdAt).getTime() < new Date(oldest.createdAt).getTime() ? account : oldest
              }).id
              await db.delete(accountTable)
                .where(and(
                  eq(accountTable.userId, userId),
                  eq(accountTable.providerId, 'slack'),
                  ne(accountTable.id, oldestAccountId),
                ))

              c.context.logger.warn(`Deleted duplicate Slack accounts for user ${userId}, kept ${oldestAccountId}`)
              return
            }
            const slackAccount = slackAccounts[0]

            const accessToken = await decryptOAuthToken(slackAccount.accessToken || '', c.context)
            const userInfo = await slackProvider.getUserInfo({ accessToken })
            if (!userInfo) {
              c.context.logger.error('No Slack userInfo found')
              await c.context.internalAdapter.deleteSession(sessionToken)
              return
            }

            const slackData = userInfo.data as SlackProfile
            const slackTeamId = slackData['https://slack.com/team_id']
            const slackTeamName = slackData['https://slack.com/team_name']
            const slackTeamDomain = slackData['https://slack.com/team_domain']

            // Update the Slack account with the teamId
            await db.update(accountTable)
              .set({ teamId: slackTeamId })
              .where(eq(accountTable.id, slackAccount.id))

            try {
              // Query for existing organization with this Slack team ID
              const [existingOrg] = await db.select()
                .from(organizationTable)
                .where(eq(organizationTable.slackTeamId, slackTeamId))
                .limit(1)

              if (!existingOrg) {
                // Create new organization using db
                const [newOrg] = await db.insert(organizationTable)
                  .values({
                    id: generateId(),
                    name: slackTeamName,
                    slug: slackTeamDomain,
                    slackTeamId,
                  })
                  .returning()

                // Remove user from any existing organizations
                const removedOrgs = await db
                  .delete(memberTable)
                  .where(eq(memberTable.userId, userId))
                  .returning()

                for (const membership of removedOrgs) {
                  c.context.logger.info(`Removed user ${userId} from organization ${membership.organizationId}`)
                }

                // Add member to the new organization
                await auth.api.addMember({
                  body: {
                    userId,
                    organizationId: newOrg.id,
                    role: 'member',
                  },
                })

                c.context.logger.info(`Created organization ${newOrg.id} for Slack team ${slackTeamId}`)
              } else {
                // Check if user is already a member
                const [existingMember] = await db.select()
                  .from(memberTable)
                  .where(and(
                    eq(memberTable.organizationId, existingOrg.id),
                    eq(memberTable.userId, userId),
                  ))
                  .limit(1)

                if (!existingMember) {
                  // Remove user from any existing organizations
                  const removedOrgs = await db
                    .delete(memberTable)
                    .where(eq(memberTable.userId, userId))
                    .returning()

                  for (const membership of removedOrgs) {
                    c.context.logger.info(`Removed user ${userId} from organization ${membership.organizationId}`)
                  }

                  // Add to the new organization
                  await auth.api.addMember({
                    body: {
                      userId,
                      organizationId: existingOrg.id,
                      role: 'member',
                    },
                  })

                  c.context.logger.info(`Added user ${userId} to organization ${existingOrg.id}`)
                }
              }
            } catch (error) {
              c.context.logger.error('Failed to create or join organization', error)
              await c.context.internalAdapter.deleteSession(sessionToken)
              return
            }
          }),
        },
      ],
    },

    schema: {
      organization: {
        fields: {
          slackTeamId: { type: 'string', required: true, unique: true },
        },
      },
      account: {
        fields: {
          teamId: { type: 'string' },
        },
      },
    },
  } satisfies BetterAuthPlugin
}

