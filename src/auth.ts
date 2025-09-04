import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import db from './db/engine'

// Quick wiring for current ngrok setup
const NGROK_URL = process.env.PV_BASE_URL || 'http://localhost:3001'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  trustedOrigins: ['http://localhost:5173', NGROK_URL],
  baseURL: NGROK_URL,
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
  advanced: {
    cookiePrefix: 'auth',
    useSecureCookies: NGROK_URL.startsWith('https'),
    crossSubdomainCookies: true,
  },
})
