import { betterAuth, generateId } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, APIError } from 'better-auth/api'
import type { Account } from 'better-auth/types'
import { organization } from 'better-auth/plugins'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import type { SlackProfile } from 'better-auth/social-providers'
import { decryptOAuthToken, generateState, createAuthorizationURL, parseState } from 'better-auth/oauth2'
import { symmetricEncrypt } from 'better-auth/crypto'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createRandomStringGenerator } from '@better-auth/utils/random'
import type { Installation, OAuthV2Response } from '@slack/oauth'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { WebClient } from '@slack/web-api'
import db from './db/engine'
import { betterAuthSchema, organizationTable, memberTable, slackAppInstallationTable } from './db/schema/auth'
import { clearCalendarPromptMessages } from './calendar-service'
import { getSlackClient } from './integrations/slack'

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

export const SLACK_APP_SCOPES = [
  'channels:history',
  'channels:join',
  'channels:read',
  'chat:write',
  'im:history',
  'im:read',
  'im:write',
  'mpim:read',
  'mpim:write',
  'reactions:read',
  'reactions:write',
  'users:read',
  'users:read.email',
  'mpim:history',
  'channels:manage',
  'canvases:read',
  'groups:history',
  'groups:read',
  'groups:write',
  'links:read',
  'emoji:read',
  'files:read',
  'pins:read',
  'search:read.users',
  'team:read',
  'usergroups:read',
  'users.profile:read',
]

export function slackAppInstallationPlugin() {
  return {
    id: 'slack-app-installation-plugin',

    endpoints: {
      // Initiate Slack app OAuth flow
      authorize: createAuthEndpoint('/slack-app/init-install', {
        method: 'POST',
        body: z.strictObject({
          'callbackURL': z.string(),
        }),
      },async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        const { state, codeVerifier } = await generateState(c, {
          userId: session.user.id,
          email: session.user.email,
        })

        const installUrl = await createAuthorizationURL({
          id: '', // unused
          options: {
            clientId: process.env.PV_SLACK_CLIENT_ID,
            clientSecret: process.env.PV_SLACK_CLIENT_SECRET,
          },
          redirectURI: `${c.context.baseURL}/slack-app/callback`,
          authorizationEndpoint: 'https://slack.com/oauth/v2/authorize',
          state,
          codeVerifier,
          scopes: SLACK_APP_SCOPES,
        })

        return c.json({ installUrl: installUrl.toString() })
      }),

      // Handle Slack OAuth callback
      callback: createAuthEndpoint('/slack-app/callback', {
        method: 'GET',
      }, async (c) => {
        const code = c.query?.code as string | undefined
        const state = c.query?.state as string | undefined

        if (!code || !state) {
          c.context.logger.error('Missing code or state in callback')
          throw new APIError('BAD_REQUEST', {
            message: 'Missing code or state',
          })
        }

        const {
          codeVerifier,
          callbackURL,
          link,
        } = await parseState(c)

        // Verify current user session
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No user session found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No user session found',
          })
        }

        // Check that link matches current user
        if (link?.userId !== session.user.id || link?.email !== session.user.email) {
          c.context.logger.error('Link userId and email does not match current user')
          throw new APIError('FORBIDDEN', {
            message: 'User mismatch',
          })
        }

        // Exchange code for tokens
        const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: process.env.PV_SLACK_CLIENT_ID!,
            client_secret: process.env.PV_SLACK_CLIENT_SECRET!,
            code,
            code_verifier: codeVerifier,
            redirect_uri: `${c.context.baseURL}/slack-app/callback`,
          }),
        })

        const res = await tokenResponse.json() as OAuthV2Response

        if (!res.ok || !res.access_token || !res.team?.id) {
          c.context.logger.error('Failed to exchange code for token', res.error)
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Failed to exchange code for token',
          })
        }

        // Get user's organization and verify team ID matches
        const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
          .from(memberTable)
          .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
          .where(eq(memberTable.userId, session.user.id))
          .limit(1)

        if (userOrg?.slackTeamId !== res.team.id) {
          c.context.logger.error('Team ID does not match user organization')
          throw new APIError('FORBIDDEN', {
            message: 'Team ID mismatch',
          })
        }

        // Need to hit auth.test to get bot id
        const client = new WebClient(res.access_token)
        const authTestInfo = await client.auth.test()

        if (!res.bot_user_id || !authTestInfo.bot_id) {
          c.context.logger.error('Bot user not found')
          throw new APIError('NOT_FOUND', {
            message: 'Bot user not found',
          })
        }

        if (res.authed_user.access_token) {
          c.context.logger.error('User auth is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'User auth is not supported',
          })
        }

        if (res.is_enterprise_install) {
          c.context.logger.error('Enterprise install is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'Enterprise install is not supported',
          })
        }

        if (res.incoming_webhook) {
          c.context.logger.error('Incoming webhook is not supported')
          throw new APIError('FORBIDDEN', {
            message: 'Incoming webhook is not supported',
          })
        }

        // Parse the slack api response into a node-slack-sdk Installation object
        // See https://github.com/slackapi/node-slack-sdk/blob/main/packages/oauth/src/install-provider.ts
        const installation: Installation<'v2', boolean> = {
          authVersion: 'v2',
          team: res.team,
          enterprise: res.enterprise == null ? undefined : res.enterprise,
          user: {
            token: undefined,
            scopes: undefined,
            id: res.authed_user.id,
          },
          bot: {
            scopes: res.scope?.split(',') || [],
            token: await symmetricEncrypt({
              key: c.context.secret,
              data: res.access_token,
            }),
            userId: res.bot_user_id,
            id: authTestInfo.bot_id,
          },
          tokenType: res.token_type,
          isEnterpriseInstall: res.is_enterprise_install,
          enterpriseUrl: res.is_enterprise_install ? authTestInfo.url : undefined,
          appId: res.app_id,
        }

        // Handle token rotation if it is enabled
        if (res.refresh_token !== undefined && res.expires_in !== undefined && installation.bot) {
          const currentUTC = Math.floor(Date.now() / 1000) // utc, seconds
          installation.bot.refreshToken = res.refresh_token
          installation.bot.expiresAt = currentUTC + res.expires_in
        }

        // Store bot token in slackAppInstallation table
        await db.insert(slackAppInstallationTable)
          .values({
            id: generateId(),
            teamId: res.team.id,
            installation,
            createdByUserId: session.user.id,
          })
          .onConflictDoUpdate({
            target: slackAppInstallationTable.teamId,
            set: {
              installation,
              createdByUserId: session.user.id,
              createdAt: new Date(),
            },
          })

        c.context.logger.info(`Slack app installed for team ${res.team.id}`)

        return c.redirect(callbackURL)
      }),

      // Uninstall Slack app
      uninstall: createAuthEndpoint('/slack-app/uninstall', {
        method: 'POST',
      }, async (c) => {
        const session = await getSessionFromCtx(c)
        if (!session?.user) {
          c.context.logger.error('No logged in user found')
          throw new APIError('UNAUTHORIZED', {
            message: 'No logged in user found',
          })
        }

        // Get the Slack client for this user
        const client = await getSlackClient(session.user.id)
        if (!client) {
          c.context.logger.error('No Slack app installation found for user')
          throw new APIError('NOT_FOUND', {
            message: 'No Slack app installation found',
          })
        }

        // Call apps.uninstall
        try {
          await client.apps.uninstall({
            client_id: process.env.PV_SLACK_CLIENT_ID!,
            client_secret: process.env.PV_SLACK_CLIENT_SECRET!,
          })
        } catch (error) {
          c.context.logger.error('Failed to uninstall Slack app', error)
          throw new APIError('INTERNAL_SERVER_ERROR', {
            message: 'Failed to uninstall Slack app',
          })
        }

        // Delete the slackAppInstallation record
        const [result] = await db.select({ teamId: organizationTable.slackTeamId })
          .from(memberTable)
          .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
          .where(eq(memberTable.userId, session.user.id))
          .limit(1)

        if (result?.teamId) {
          await db.delete(slackAppInstallationTable)
            .where(eq(slackAppInstallationTable.teamId, result.teamId))
        }

        c.context.logger.info('Slack app uninstalled successfully')

        return c.json({ success: true })
      }),
    },

    schema: {
      slackAppInstallation: {
        fields: {
          teamId: {
            type: 'string',
            required: true,
            unique: true,
            references: {
              model: 'organization',
              field: 'slackTeamId',
              onDelete: 'cascade',
            },
          },
          installation: {
            type: 'json',
            required: true,
          },
          createdByUserId: {
            type: 'string',
            required: true,
            references: {
              model: 'user',
              field: 'id',
              onDelete: 'cascade',
            },
          },
          createdAt: {
            type: 'date',
            required: true,
          },
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
    googleCalendarCleanupPlugin(),
    slackAppInstallationPlugin(),
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
      disableSignUp: true,
    },
    google: {
      clientId: process.env.PV_GOOGLE_CLIENT_ID!,
      clientSecret: process.env.PV_GOOGLE_CLIENT_SECRET!,
      disableSignUp: true,
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
