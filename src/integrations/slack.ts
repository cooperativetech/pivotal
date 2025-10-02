import { and, eq } from 'drizzle-orm'
import { symmetricDecrypt } from 'better-auth/crypto'
import { WebClient } from '@slack/web-api'
import db from '../db/engine'
import { accountTable, memberTable, organizationTable, slackAppInstallationTable } from '../db/schema/auth'

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
