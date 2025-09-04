import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import db from '../db/engine'
import { topicTable, slackUserTable } from '../db/schema/main'
import { session, user, account } from '../db/schema/auth'
import { auth } from '../auth'

async function getSessionUser(c: Context) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.replace('Bearer ', '')
  const [sessionRecord] = await db
    .select({
      userId: session.userId,
    })
    .from(session)
    .where(eq(session.token, token))
    .limit(1)

  return sessionRecord || null
}

export const apiRoutes = new Hono()

  // CORS middleware for auth routes
  .use('/auth/*', cors({
    origin: ['http://localhost:5173', process.env.PV_BASE_URL || 'http://localhost:3001'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    credentials: true,
  }))

  // Auth routes
  .all('/auth/*', (c) => {
    return auth.handler(c.req.raw)
  })

  // CORS for non-auth API routes
  .use('*', cors({
    origin: 'http://localhost:5173',
    allowHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    credentials: true,
  }))

  .get('/profile', async (c) => {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user info from auth table
      const [userInfo] = await db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
        })
        .from(user)
        .where(eq(user.id, sessionUser.userId))
        .limit(1)

      if (!userInfo) {
        return c.json({ error: 'User not found' }, 404)
      }

      // Get linked Slack IDs from auth account table
      const linkedSlackIds = await db
        .select({ slackId: account.accountId })
        .from(account)
        .where(and(
          eq(account.userId, sessionUser.userId),
          eq(account.providerId, 'slack'),
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
      const linkedSlackAccounts = slackIdList.map((id) => (
        slackMap.get(id) || { id, realName: null, teamId: 'unknown' }
      ))

      return c.json({
        user: {
          id: userInfo.id,
          email: userInfo.email,
          name: userInfo.name,
        },
        slackAccounts: linkedSlackAccounts,
      })
    } catch (error) {
      console.error('Error fetching profile:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/profile/topics', async (c) => {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user's linked Slack account IDs from auth account table
      const linkedSlackIds = await db
        .select({ slackId: account.accountId })
        .from(account)
        .where(and(
          eq(account.userId, sessionUser.userId),
          eq(account.providerId, 'slack'),
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

      return c.json({ topics })
    } catch (error) {
      console.error('Error fetching user topics:', error)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  .get('/topics/:topicId', async (c) => {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const topicId = c.req.param('topicId')

    try {
      // Import the dumpTopic utility
      const { dumpTopic } = await import('../utils')

      // Get topic data
      const topicData = await dumpTopic(topicId, {})

      // Check if user has access to this topic (via their Slack accounts)
      const linkedSlackIds = await db
        .select({ slackId: account.accountId })
        .from(account)
        .where(and(
          eq(account.userId, sessionUser.userId),
          eq(account.providerId, 'slack'),
        ))

      const userSlackIds = new Set(linkedSlackIds.map((s) => s.slackId))
      const topicUserIds = new Set(topicData.topic.userIds)

      // Check if any of the user's Slack IDs are in the topic
      const hasAccess = [...userSlackIds].some((id) => topicUserIds.has(id))

      if (!hasAccess) {
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
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user's linked Slack accounts
      const linkedSlackIds = await db
        .select({ slackId: account.accountId })
        .from(account)
        .where(and(
          eq(account.userId, sessionUser.userId),
          eq(account.providerId, 'slack'),
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
