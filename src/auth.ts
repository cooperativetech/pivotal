import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { slack } from 'better-auth/providers/slack'
import db from './db/engine'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  socialProviders: [
    slack({ clientId: process.env.PV_SLACK_CLIENT_ID!, clientSecret: process.env.PV_SLACK_CLIENT_SECRET! })
  ],
  hooks: {
    // optional: after sign-in/link, sync Slack profile to slack_user table
  }
})
