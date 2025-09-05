import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import db from './db/engine'
import { betterAuthSchema } from './db/schema/auth'

const baseURL = (
  process.env.PV_NODE_ENV === 'local' ?
  'https://localhost:5173' :
  process.env.PV_BASE_URL || 'https://localhost:3009'
)

export const auth = betterAuth({
  baseURL,
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
    accountLinking: {
      enabled: true,
      trustedProviders: ['slack'],
    },
  },
  telemetry: {
    enabled: false,
  },
})
