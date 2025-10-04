import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { refreshAccessToken } from 'better-auth/oauth2'
import { symmetricDecrypt } from 'better-auth/crypto'
import db from '../db/engine'
import { betterAuthSchema } from '../db/schema/auth'
import { slackTeamPlugin } from './slack-team-plugin'
import { googleCalendarCleanupPlugin } from './google-calendar-cleanup-plugin'
import { slackAppInstallationPlugin, SLACK_APP_SCOPES } from './slack-app-installation-plugin'
import { githubAppInstallationPlugin } from './github-app-installation-plugin'

export { SLACK_APP_SCOPES, slackAppInstallationPlugin, githubAppInstallationPlugin }

export const baseURL = (
  process.env.PV_NODE_ENV === 'local' ?
  'https://localhost:5173' :
  process.env.PV_BASE_URL || 'https://localhost:3009'
)

if (process.env.PV_NODE_ENV === 'prod' && !process.env.PV_BETTER_AUTH_SECRET) {
  throw new Error('PV_BETTER_AUTH_SECRET required for production')
}

// Need this shim because better-auth doesn't decrypt the refreshToken by default
function genRefreshAccessToken(tokenEndpoint: string, clientId: string, clientSecret: string) {
  return async (encryptedToken: string) => {
    const refreshToken = await symmetricDecrypt({
      key: process.env.PV_BETTER_AUTH_SECRET!,
      data: encryptedToken,
    })
    return refreshAccessToken({
      refreshToken,
      options: { clientId, clientSecret },
      tokenEndpoint,
    })
  }
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
      refreshAccessToken: genRefreshAccessToken(
        'https://slack.com/api/openid.connect.token',
        process.env.PV_SLACK_CLIENT_ID!,
        process.env.PV_SLACK_CLIENT_SECRET!,
      ),
    },
    github: {
      clientId: process.env.PV_GITHUB_CLIENT_ID!,
      clientSecret: process.env.PV_GITHUB_CLIENT_SECRET!,
      disableSignUp: true,
      refreshAccessToken: genRefreshAccessToken(
        'https://github.com/login/oauth/access_token',
        process.env.PV_GITHUB_CLIENT_ID!,
        process.env.PV_GITHUB_CLIENT_SECRET!,
      ),
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
      refreshAccessToken: genRefreshAccessToken(
        'https://www.googleapis.com/oauth2/v4/token',
        process.env.PV_GOOGLE_CLIENT_ID!,
        process.env.PV_GOOGLE_CLIENT_SECRET!,
      ),
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
