import { betterAuth, generateId } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, APIError } from 'better-auth/api'
import type { Account } from 'better-auth/types'
import { organization } from 'better-auth/plugins'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import type { SlackProfile } from 'better-auth/social-providers'
import { decryptOAuthToken } from 'better-auth/oauth2'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createRandomStringGenerator } from '@better-auth/utils/random'
import { eq, and } from 'drizzle-orm'
import db from './db/engine'
import { betterAuthSchema, organizationTable, memberTable } from './db/schema/auth'

export const baseURL = (
  process.env.PV_NODE_ENV === 'local' ?
  'https://localhost:5173' :
  process.env.PV_BASE_URL || 'https://localhost:3009'
)

if (process.env.PV_NODE_ENV === 'prod' && !process.env.PV_BETTER_AUTH_SECRET) {
  throw new Error('PV_BETTER_AUTH_SECRET required for production')
}

const generateRandomString = createRandomStringGenerator('a-z', '0-9', 'A-Z', '-_')

export function slackTeamPlugin() {
  return {
    id: 'slack-team-plugin',
    // After slack login, assign the user to an organization based on the slack team id
    hooks: {
      after: [{
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
          const slackAccount = accounts.find((account) => account.providerId === 'slack')
          if (!slackAccount) {
            c.context.logger.error('No Slack account found for user')
            await c.context.internalAdapter.deleteSession(sessionToken)
            return
          }

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
      }],
    },

    schema: {
      organization: {
        fields: {
          slackTeamId: { type: 'string', required: true, unique: true },
        },
      },
    },
  } satisfies BetterAuthPlugin
}

export function githubAppInstallationPlugin(appName: string) {
  return {
    id: 'github-app-installation-plugin',
    endpoints: {
      // Store verification data to imitate the default github better-auth flow, and
      // generate the github app installation url
      initiateInstallation: createAuthEndpoint('/github-app/init-install', {
        method: 'POST',
      }, async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        const state = generateRandomString(32)
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

        // For data format, see https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/oauth2/state.ts
        // TODO: add errorURL
        const data = JSON.stringify({
          callbackURL: `${c.context.options.baseURL}/profile`,
          codeVerifier: '', // Required by github callback, but ignored if empty string
          link: {
            email: session.user.email,
            userId: session.user.id,
          },
          expiresAt: expiresAt.getTime(),
        })

        const verification = await c.context.internalAdapter.createVerificationValue(
          {
            value: data,
            identifier: state,
            expiresAt,
          },
          c,
        )
        if (!verification) {
          c.context.logger.error('Unable to create verification')
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Unable to create verification',
          })
        }

        // Construct Github App installation URL
        const installUrl = new URL(`https://github.com/apps/${appName}/installations/new`)
        installUrl.searchParams.set('state', state)

        return c.json({ installUrl: installUrl.toString() })
      }),
    },

    // Save installation id to the user after the standard oauth callback
    hooks: {
      after: [{
        matcher: (c) => {
          return c.path === '/callback/:id' && c.params?.id === 'github'
        },
        handler: createAuthMiddleware(async (c) => {
          const installationId = c.query?.installation_id as string | undefined
          if (!installationId) {
            c.context.logger.error('No installation_id found after Github callback')
            return
          }

          const session = await getSessionFromCtx(c)
          if (!session?.user) {
            c.context.logger.error('No user session found after Github callback')
            return
          }

          // Find the Github account for this user
          const accounts = await c.context.internalAdapter.findAccounts(session.user.id)
          const githubAccount = accounts.find((account) => account.providerId === 'github')
          if (!githubAccount) {
            c.context.logger.error('No Github account found for user')
            return
          }

          // Update the account with the installation ID
          // Using type assertion since installationId is a custom field
          await c.context.internalAdapter.updateAccount(
            githubAccount.id,
            { installationId } as Partial<Account>,
          )

          c.context.logger.info('Github installation ID saved successfully')
        }),
      }],
    },

    // Allow adding an installation id to an account
    schema: {
      account: {
        fields: {
          installationId: { type: 'string' },
          repositoryId: { type: 'string' },
        },
      },
    },
  } satisfies BetterAuthPlugin
}

export const auth = betterAuth({
  baseURL,
  secret: process.env.PV_BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: betterAuthSchema,
  }),
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      organizationLimit: 1,
    }),
    slackTeamPlugin(),
    githubAppInstallationPlugin(process.env.PV_GITHUB_APP_NAME!),
  ],
  socialProviders: {
    slack: {
      clientId: process.env.PV_SLACK_CLIENT_ID!,
      clientSecret: process.env.PV_SLACK_CLIENT_SECRET!,
    },
    github: {
      clientId: process.env.PV_GITHUB_CLIENT_ID!,
      clientSecret: process.env.PV_GITHUB_CLIENT_SECRET!,
    },
    google: {
      clientId: process.env.PV_GOOGLE_CLIENT_ID!,
      clientSecret: process.env.PV_GOOGLE_CLIENT_SECRET!,
      scope: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ],
      accessType: 'offline', // Required to get a refresh token
      prompt: 'consent', // Required to get a refresh token
    },
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      allowUnlinkingAll: true,
      trustedProviders: ['slack', 'github', 'google'],
    },
  },
  rateLimit: {
    enabled: true,
  },
  advanced: {
    useSecureCookies: true,
  },
  telemetry: {
    enabled: false,
  },
})
