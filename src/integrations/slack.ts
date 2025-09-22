import { and, eq } from 'drizzle-orm'
import { WebClient } from '@slack/web-api'
import db from '../db/engine'
import { accountTable } from '../db/schema/auth'
import { slackUserTable } from '../db/schema/main'
import type { SlackAccount } from '@shared/api-types'

export async function getLinkedSlackAccount(userId: string): Promise<SlackAccount | null> {
  const linkedSlackIds = await db
    .select({ slackId: accountTable.accountId })
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'slack'),
    ))
    .limit(1)

  if (linkedSlackIds.length === 0) {
    return null
  }

  const slackId = linkedSlackIds[0].slackId

  // Get Slack user details
  const [slackUser] = await db
    .select({
      id: slackUserTable.id,
      realName: slackUserTable.realName,
      teamId: slackUserTable.teamId,
    })
    .from(slackUserTable)
    .where(eq(slackUserTable.id, slackId))
    .limit(1)

  const teamId = slackUser?.teamId ?? 'unknown'

  // Best-effort team name using bot token (only resolves current workspace)
  let teamName: string | null = null
  try {
    if (process.env.PV_SLACK_BOT_TOKEN && teamId !== 'unknown') {
      const client = new WebClient(process.env.PV_SLACK_BOT_TOKEN)
      const info = await client.team.info()
      if (info.ok && info.team?.id === teamId && info.team?.name) {
        teamName = info.team.name
      }
    }
  } catch (err) {
    console.warn('team.info failed:', err)
  }

  // Return the slack account info, mirroring the structure from api.ts
  return {
    id: slackId,
    realName: slackUser?.realName ?? null,
    teamId,
    teamName,
  }
}
