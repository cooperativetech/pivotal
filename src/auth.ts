import { betterAuth } from 'better-auth'
import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, APIError } from 'better-auth/api'
import type { Account } from 'better-auth/types'
import type { BetterAuthPlugin } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { createRandomStringGenerator } from '@better-auth/utils/random'
import db from './db/engine'
import { betterAuthSchema } from './db/schema/auth'

export const baseURL = (
  process.env.PV_NODE_ENV === 'local' ?
  'https://localhost:5173' :
  process.env.PV_BASE_URL || 'https://localhost:3009'
)

if (process.env.PV_NODE_ENV === 'prod' && !process.env.PV_BETTER_AUTH_SECRET) {
  throw new Error('PV_BETTER_AUTH_SECRET required for production')
}

const generateRandomString = createRandomStringGenerator('a-z', '0-9', 'A-Z', '-_')

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
        const expiresAt = new Date()
        expiresAt.setMinutes(expiresAt.getMinutes() + 10)

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
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: ['slack', 'github'],
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
