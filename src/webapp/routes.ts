import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import db from '../db/engine'
import { topicTable, slackUserTable } from '../db/schema/main'
import { session, user } from '../db/schema/auth'
import { auth } from '../auth'

export const webappRoutes = new Hono()

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

// Routes will be added here
webappRoutes.on(['POST', 'GET'], '/auth/*', (c) => {
  return auth.handler(c.req.raw)
})

webappRoutes.get('/profile', async (c) => {
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

    // Get linked Slack accounts
    const linkedSlackAccounts = await db
      .select({
        id: slackUserTable.id,
        realName: slackUserTable.realName,
        teamId: slackUserTable.teamId,
      })
      .from(slackUserTable)
      .where(eq(slackUserTable.authUserId, sessionUser.userId))

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

webappRoutes.get('/profile/topics', async (c) => {
  const sessionUser = await getSessionUser(c)
  if (!sessionUser) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  try {
    // Get user's linked Slack account IDs
    const linkedSlackIds = await db
      .select({
        slackId: slackUserTable.id,
      })
      .from(slackUserTable)
      .where(eq(slackUserTable.authUserId, sessionUser.userId))

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