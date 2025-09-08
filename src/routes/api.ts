import { Hono } from 'hono'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import db from '../db/engine'
import { WebClient } from '@slack/web-api'
import { topicTable, slackUserTable } from '../db/schema/main'
import { accountTable } from '../db/schema/auth'
import { auth } from '../auth'

interface SessionVars {
  user: typeof auth.$Infer.Session.user | null
  session: typeof auth.$Infer.Session.session | null
}

export const apiRoutes = new Hono<{ Variables: SessionVars }>()
  .use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      c.set('user', null)
      c.set('session', null)
      return next()
    }
    c.set('user', session.user)
    c.set('session', session.session)
    return next()
  })

  .all('/auth/*', (c) => {
    return auth.handler(c.req.raw)
  })

  .get('/profile', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get linked Slack IDs from auth account table
      const linkedSlackIds = await db
        .select({ slackId: accountTable.accountId })
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))

      const slackIdList = linkedSlackIds.map((s) => s.slackId)

      // Fetch Slack user details if we have any IDs
      const slackRows = slackIdList.length > 0
        ? await db
            .select({ id: slackUserTable.id, realName: slackUserTable.realName, teamId: slackUserTable.teamId })
            .from(slackUserTable)
            .where(inArray(slackUserTable.id, slackIdList))
        : []

      // Ensure we return an entry per linked Slack account, even if user hasn't messaged the bot yet
      const slackMap = new Map(slackRows.map((r) => [r.id, r]))
      // Best-effort team name using bot token (only resolves current workspace)
      const teamNameCache = new Map<string, string>()
      try {
        if (process.env.PV_SLACK_BOT_TOKEN) {
          const client = new WebClient(process.env.PV_SLACK_BOT_TOKEN)
          const info = await client.team.info()
          if (info.ok && info.team?.id && info.team?.name) {
            teamNameCache.set(info.team.id, info.team.name)
          }
        }
      } catch (err) {
        console.warn('team.info failed:', err)
      }

      const linkedSlackAccounts = slackIdList.map((id) => {
        const row = slackMap.get(id)
        const teamId = row?.teamId || 'unknown'
        const teamName = teamNameCache.get(teamId) || null
        return { id, realName: row?.realName ?? null, teamId, teamName }
      })

      return c.json({
        user: {
          id: sessionUser.id,
          email: sessionUser.email,
          name: sessionUser.name,
        },
        slackAccounts: linkedSlackAccounts,
      })
    } catch (error) {
      console.error('Error fetching profile:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/profile/topics', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user's linked Slack account IDs from auth account table
      const linkedSlackIds = await db
        .select({ slackId: accountTable.accountId })
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))

      if (linkedSlackIds.length === 0) {
        return c.json({ topics: [] })
      }

      // Get topics that include any of the user's Slack IDs
      const slackIdList = linkedSlackIds.map((s) => s.slackId)

      // Use raw SQL for JSONB array overlap query
      const topics = await db
        .select()
        .from(topicTable)
        .where(
          sql`${topicTable.userIds}::jsonb ?| array[${sql.join(slackIdList.map((id) => sql`${id}`), sql`, `)}]`,
        )
        .orderBy(desc(topicTable.updatedAt))

      // Build participant names per topic
      const allUserIds = new Set<string>()
      for (const t of topics) t.userIds.forEach((id: string) => allUserIds.add(id))
      const users = allUserIds.size > 0
        ? await db
            .select({ id: slackUserTable.id, realName: slackUserTable.realName })
            .from(slackUserTable)
            .where(inArray(slackUserTable.id, Array.from(allUserIds)))
        : []
      const nameById = new Map(users.map((u) => [u.id, u.realName || u.id]))
      const myIds = new Set(slackIdList)
      const lastName = (full: string) => {
        const parts = full.trim().split(/\s+/)
        return parts.length > 1 ? parts[parts.length - 1] : parts[0]
      }
      const topicsWithNames = topics.map((t) => {
        const me = t.userIds.filter((id: string) => myIds.has(id)).map((id: string) => nameById.get(id) || id)
        const others = t.userIds.filter((id: string) => !myIds.has(id)).map((id: string) => nameById.get(id) || id)
          .sort((a, b) => lastName(a).localeCompare(lastName(b)))
        return { ...t, participantNames: [...me, ...others] }
      })

      return c.json({ topics: topicsWithNames })
    } catch (error) {
      console.error('Error fetching user topics:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/topics/:topicId', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const topicId = c.req.param('topicId')

    try {
      // Import the dumpTopic utility
      const { dumpTopic } = await import('../utils')

      // Get user's linked Slack accounts
      const linkedSlackIds = await db
        .select({ slackId: accountTable.accountId })
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))
      const userSlackIds = new Set(linkedSlackIds.map((s) => s.slackId))

      // Check access against the topic's user list
      const [topicRow] = await db
        .select({ userIds: topicTable.userIds })
        .from(topicTable)
        .where(eq(topicTable.id, topicId))
        .limit(1)

      if (!topicRow) {
        return c.json({ error: 'Not found' }, 404)
      }

      const topicUserIds = new Set(topicRow.userIds)
      const hasAccess = [...userSlackIds].some((id) => topicUserIds.has(id))
      if (!hasAccess) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      // Return only data visible to the current user's Slack accounts (messages/channels only)
      const topicData = await dumpTopic(topicId, { visibleToUserIds: Array.from(userSlackIds) })
      return c.json(topicData)
    } catch (error) {
      console.error('Error fetching topic data:', error)
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404)
      }
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/users', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user's linked Slack accounts
      const linkedSlackIds = await db
        .select({ slackId: accountTable.accountId })
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))

      const slackIdList = linkedSlackIds.map((s) => s.slackId)

      // Get Slack user details for the linked accounts
      const users = slackIdList.length > 0
        ? await db
            .select({
              id: slackUserTable.id,
              realName: slackUserTable.realName,
              tz: slackUserTable.tz,
              isBot: slackUserTable.isBot,
            })
            .from(slackUserTable)
            .where(inArray(slackUserTable.id, slackIdList))
        : []

      // Return users array (for compatibility with TopicCreation component)
      return c.json({ users })
    } catch (error) {
      console.error('Error fetching users:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })
