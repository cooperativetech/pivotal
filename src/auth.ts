import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import db from './db/engine'
import { betterAuthSchema } from './db/schema/auth'

const baseURL = (
  process.env.PV_NODE_ENV === 'local' ?
  'https://localhost:5173' :
  process.env.PV_BASE_URL || 'https://localhost:3009'
)

if (process.env.PV_NODE_ENV === 'prod' && !process.env.PV_BETTER_AUTH_SECRET) {
  throw new Error('PV_BETTER_AUTH_SECRET required for production')
}

export const auth = betterAuth({
  baseURL,
  secret: process.env.PV_BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: betterAuthSchema,
  }),
  socialProviders: {
    slack: {
      clientId: process.env.PV_SLACK_CLIENT_ID!,
      clientSecret: process.env.PV_SLACK_CLIENT_SECRET!,
    },
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: ['slack'],
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
