import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import db from './db/engine'
import { slackUserTable } from './db/schema/main'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
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
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          // If this is a Slack account, try to link it to existing slack_user record
          if (account.providerId === 'slack' && account.accountId) {
            try {
              // Update the slack_user record to link it to the auth user
              await db
                .update(slackUserTable)
                .set({ authUserId: account.userId })
                .where(eq(slackUserTable.id, account.accountId))

              console.log(`Linked Slack user ${account.accountId} to auth user ${account.userId}`)
            } catch (error) {
              console.error('Failed to link Slack user to auth user:', error)
            }
          }
        },
      },
    },
  },
})
