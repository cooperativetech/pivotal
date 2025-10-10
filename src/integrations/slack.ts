import { and, eq } from 'drizzle-orm'
import { symmetricDecrypt } from 'better-auth/crypto'
import { WebClient } from '@slack/web-api'
import db from '../db/engine'
import { accountTable, memberTable, organizationTable, slackAppInstallationTable } from '../db/schema/auth'
import { mockSlackClient } from '../local-helpers'

const teamClientCache = new Map<string, WebClient>()

export async function getLinkedSlackAccount(userId: string) {
  const [linkedSlackAccount] = await db.select()
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'slack'),
    ))
    .limit(1)

  if (!linkedSlackAccount) {
    return null
  }

  return {
    accountId: linkedSlackAccount.accountId,
  }
}

export async function getSlackClient(userId: string) {
  const [res] = await db.select({ installation: slackAppInstallationTable.installation })
    .from(memberTable)
    .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
    .innerJoin(slackAppInstallationTable, eq(organizationTable.slackTeamId, slackAppInstallationTable.teamId))
    .where(eq(memberTable.userId, userId))
    .limit(1)

  if (!res || !res.installation.bot) {
    return null
  }

  const botToken = await symmetricDecrypt({
    key: process.env.PV_BETTER_AUTH_SECRET!,
    data: res.installation.bot.token,
  })

  return new WebClient(botToken)
}

export async function getSlackClientForTeam(teamId: string): Promise<WebClient | null> {
  if (process.env.PV_NODE_ENV === 'local') {
    return mockSlackClient
  }

  if (!teamId) {
    return null
  }

  const cached = teamClientCache.get(teamId)
  if (cached) {
    return cached
  }

  const [res] = await db.select({ installation: slackAppInstallationTable.installation })
    .from(slackAppInstallationTable)
    .where(eq(slackAppInstallationTable.teamId, teamId))
    .limit(1)

  const encryptedToken = res?.installation.bot?.token
  if (!encryptedToken) {
    return null
  }

  const secret = process.env.PV_BETTER_AUTH_SECRET
  if (!secret) {
    console.warn('[Slack] Missing PV_BETTER_AUTH_SECRET while fetching team Slack client.')
    return null
  }

  try {
    const botToken = await symmetricDecrypt({
      key: secret,
      data: encryptedToken,
    })

    const client = new WebClient(botToken)
    teamClientCache.set(teamId, client)
    return client
  } catch (error) {
    console.error(`[Slack] Failed to decrypt bot token for team ${teamId}:`, error)
    return null
  }
}
