import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import db from './db/engine'
import { slackUserTable } from './db/schema/main'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  trustedOrigins: ['http://localhost:5173'],
  baseURL: 'https://015231acd470.ngrok-free.app',
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
          // If this is a Slack account, upsert the slack_user record
          if (account.providerId === 'slack' && account.accountId) {
            try {
              // First try to update existing slack_user record
              const updateResult = await db
                .update(slackUserTable)
                .set({ authUserId: account.userId })
                .where(eq(slackUserTable.id, account.accountId))

              // If no rows were updated, insert a new slack_user record with real OAuth data
              if (updateResult.rowCount === 0) {
                // Extract real user data from OAuth profile (if available)
                // Note: Better-auth may not always provide profile data
                const accountWithProfile = account as { profile?: Record<string, unknown> }
                const slackProfile = accountWithProfile.profile || {}
                await db.insert(slackUserTable).values({
                  id: account.accountId,
                  teamId: typeof slackProfile.team === 'object' && slackProfile.team && 'id' in slackProfile.team
                    ? String(slackProfile.team.id)
                    : 'unknown',
                  realName: typeof slackProfile.real_name === 'string'
                    ? slackProfile.real_name
                    : (typeof slackProfile.name === 'string' ? slackProfile.name : null),
                  email: typeof slackProfile.email === 'string' ? slackProfile.email : null,
                  tz: typeof slackProfile.tz === 'string' ? slackProfile.tz : null,
                  isBot: false,
                  deleted: false,
                  updated: new Date(),
                  raw: slackProfile,
                  authUserId: account.userId,
                })
                console.log(`Created new Slack user ${account.accountId} with profile data and linked to auth user ${account.userId}`)
              } else {
                console.log(`Updated existing Slack user ${account.accountId} to link to auth user ${account.userId}`)
              }
            } catch (error) {
              console.error('Failed to upsert Slack user:', error)
            }
          }
        },
      },
    },
  },
})
