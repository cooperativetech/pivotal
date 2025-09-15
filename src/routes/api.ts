import { Hono } from 'hono'
import { and, eq, inArray } from 'drizzle-orm'
import db from '../db/engine'
import { WebClient } from '@slack/web-api'
import { slackUserTable } from '../db/schema/main'
import { accountTable } from '../db/schema/auth'
import { auth } from '../auth'
import { dumpTopic, getTopics } from '../utils'
import { generateGoogleAuthUrl } from '../calendar-service'

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
        return c.json({ topics: [], userNameMap: {} })
      }

      const slackIdList = linkedSlackIds.map((s) => s.slackId)
      const slackIdSet = new Set(slackIdList)

      // Get all topics (no filtering by bot user ID)
      const allTopics = await getTopics()

      // Filter topics in TypeScript to include only those with user's Slack IDs
      const userTopics = allTopics.filter((topic) => (
        topic.state.userIds.some((userId) => slackIdSet.has(userId))
      ))

      // Build user ID to name mapping
      const allUserIds = new Set<string>()
      for (const topic of userTopics) {
        topic.state.userIds.forEach((id) => allUserIds.add(id))
      }

      const users = allUserIds.size > 0
        ? await db
            .select({ id: slackUserTable.id, realName: slackUserTable.realName })
            .from(slackUserTable)
            .where(inArray(slackUserTable.id, Array.from(allUserIds)))
        : []

      const userNameMap: Record<string, string> = {}
      for (const user of users) {
        userNameMap[user.id] = user.realName || user.id
      }

      return c.json({ topics: userTopics, userNameMap })
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
      // Get user's linked Slack accounts
      const linkedSlackIds = await db
        .select({ slackId: accountTable.accountId })
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))
      const userSlackIds = new Set(linkedSlackIds.map((s) => s.slackId))

      // Return only data visible to the current user's Slack accounts (messages/channels only)
      const topicData = await dumpTopic(topicId, { visibleToUserIds: Array.from(userSlackIds) })

      // If the user has no messages visible, they can't access this topic
      if (topicData.messages.length < 1) {
        return c.json({ error: 'Forbidden' }, 403)
      }

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

  // Generate Google auth URL (webapp). topicId optional; if omitted, use 'profile'.
  .get('/calendar/auth_url', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // Parse query
    const url = new URL(c.req.url)
    const topicId = url.searchParams.get('topicId') || 'profile'
    const slackUserIdParam = url.searchParams.get('slackUserId')

    try {
      // Determine slackUserId: prefer explicit, else first linked account
      let slackUserId = slackUserIdParam || null
      if (!slackUserId) {
        const linked = await db
          .select({ slackId: accountTable.accountId })
          .from(accountTable)
          .where(and(
            eq(accountTable.userId, sessionUser.id),
            eq(accountTable.providerId, 'slack'),
          ))
        slackUserId = linked[0]?.slackId || null
      }

      if (!slackUserId) {
        return c.json({ error: 'No linked Slack account found' }, 400)
      }

      const authUrl = generateGoogleAuthUrl(topicId, slackUserId)
      return c.json({ url: authUrl })
    } catch (error) {
      console.error('Error generating Google auth URL:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })
