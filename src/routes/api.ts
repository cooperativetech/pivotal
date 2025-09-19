import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { Octokit } from '@octokit/core'
import { createOAuthUserAuth } from '@octokit/auth-oauth-user'
import { RequestError } from '@octokit/request-error'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import db from '../db/engine'
import { WebClient } from '@slack/web-api'
import { slackUserTable } from '../db/schema/main'
import { accountTable } from '../db/schema/auth'
import { auth } from '../auth'
import { dumpTopic, getTopics } from '../utils'

async function getOctokit(userId: string, accountPk: string): Promise<Octokit | null> {
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: {
        providerId: 'github',
        userId,
        accountId: accountPk,
      },
    })

    const octokit = new Octokit({
      authStrategy: createOAuthUserAuth,
      auth: {
        clientId: process.env.PV_GITHUB_CLIENT_ID,
        clientSecret: process.env.PV_GITHUB_CLIENT_SECRET,
        clientType: 'github-app',
        token: accessToken,
      },
    })

    // Test the credentials with a simple API call
    await octokit.request('GET /user')

    return octokit
  } catch (error) {
    // Check for bad credentials error
    if (error && typeof error === 'object' && 'status' in error && 'message' in error) {
      const requestError = error as { status: number; message: string }
      // Clear the user's GitHub account credentials if they are invalid
      if (requestError.status === 401 && requestError.message?.includes('Bad credentials')) {
        await db.delete(accountTable).where(eq(accountTable.id, accountPk))
        console.log(`Cleared bad GitHub credentials for account ${accountPk}`)
      }
    }

    return null
  }
}

function getBotOctokit(): Octokit {
  const token = process.env.PV_GITHUB_BOT_ACCESS_TOKEN
  if (!token) {
    throw new Error('PV_GITHUB_BOT_ACCESS_TOKEN environment variable is not set')
  }

  return new Octokit({
    auth: token,
  })
}

interface BotRepository {
  id: string
  name: string
  owner: string
  fullName: string
  invitationId: string | null
}

async function getLinkedGithubAccount(userId: string) {
  // Get linked Github account from auth account table (only one)
  const linkedGithubAccount = await db
    .select()
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'github'),
    ))
    .limit(1)

  if (linkedGithubAccount.length === 0) {
    return null
  }

  const account = linkedGithubAccount[0]
  const octokit = await getOctokit(userId, account.id)

  if (!octokit) {
    return null
  }

  try {
    const { data: profile } = await octokit.request('GET /user')
    const { data: orgs } = await octokit.request('GET /user/orgs', {
      username: profile.login,
    })
    const orgName = orgs.length > 0 ? orgs[0].login : null

    // Find all repositories in this org that 'pivotal-bot' has access to
    const botRepositories = await getAllBotRepositories()
    const repositories = botRepositories.filter((repo) => repo.owner === orgName)

    // Check if this account has a linked repository
    const linkedRepo = account.repositoryId
      ? botRepositories.find((repo) => repo.id === account.repositoryId) || null
      : null

    // If there's a linked repository, linkableRepos is empty; otherwise, it's the repositories list
    const linkableRepos = linkedRepo ? [] : repositories

    return {
      accountId: account.accountId,
      username: profile.login,
      orgName,
      repositories,
      linkedRepo,
      linkableRepos,
    }
  } catch (error) {
    console.error(`Failed to fetch GitHub profile for account ${account.id}:`, error)
    return null
  }
}

async function getAllBotRepositories(): Promise<BotRepository[]> {
  const botOctokit = getBotOctokit()
  const repositories: BotRepository[] = []

  // Get all repositories the bot has access to (with pagination)
  let page = 1
  let hasMore = true
  while (hasMore) {
    const { data: repos } = await botOctokit.request('GET /user/repos', {
      per_page: 100,
      page,
    })
    if (repos.length < 100) {
      hasMore = false
    }

    for (const repo of repos) {
      repositories.push({
        id: repo.id.toString(),
        name: repo.name,
        owner: repo.owner.login,
        fullName: repo.full_name,
        invitationId: null,
      })
    }
    page += 1
  }

  // Get all repository invitations for the bot
  page = 1
  hasMore = true
  while (hasMore) {
    const { data: invitations } = await botOctokit.request('GET /user/repository_invitations', {
      per_page: 100,
      page,
    })
    if (invitations.length < 100) {
      hasMore = false
    }

    for (const invitation of invitations) {
      repositories.push({
        id: invitation.repository.id.toString(),
        name: invitation.repository.name,
        owner: invitation.repository.owner.login,
        fullName: invitation.repository.full_name,
        invitationId: invitation.id.toString(),
      })
    }
    page += 1
  }

  return repositories
}

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

      const linkedSlackInfo = slackIdList.map((id) => {
        const row = slackMap.get(id)
        const teamId = row?.teamId || 'unknown'
        const teamName = teamNameCache.get(teamId) || null
        return { id, realName: row?.realName ?? null, teamId, teamName }
      })

      // Get linked Github account
      const githubAccount = await getLinkedGithubAccount(sessionUser.id)

      return c.json({
        user: {
          id: sessionUser.id,
          email: sessionUser.email,
          name: sessionUser.name,
        },
        slackAccounts: linkedSlackInfo,
        githubAccount,
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

  .post('/github/connect-repo', zValidator('json', z.strictObject({
    repoId: z.string(),
  })), async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const { repoId } = c.req.valid('json')

    try {

      // Get user's GitHub account
      const [githubAccount] = await db
        .select()
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'github'),
        ))
        .limit(1)

      if (!githubAccount) {
        return c.json({ error: 'GitHub account not linked' }, 400)
      }

      // Get target repo
      const botRepos = await getAllBotRepositories()
      const targetRepo = botRepos.find((r) => r.id === repoId)

      if (!targetRepo) {
        return c.json({ error: 'Bot does not have access to this repository' }, 403)
      }

      // Get app's octokit instance
      const octokit = await getOctokit(sessionUser.id, githubAccount.id)
      if (!octokit) {
        return c.json({ error: 'Invalid GitHub credentials' }, 401)
      }

      // Check if the app's octokit has access to the target repository
      try {
        await octokit.request('GET /repos/{owner}/{repo}', {
          owner: targetRepo.owner,
          repo: targetRepo.name,
        })
      } catch (error) {
        // If we get a 404, the user doesn't have access to the repository
        if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
          return c.json({ error: 'App does not have access to this repository' }, 403)
        }
        // For other errors, re-throw
        throw error
      }

      // If bot already has access (not just invitation)
      if (targetRepo.invitationId === null) {
        // Update the user's account with the repository ID
        await db
          .update(accountTable)
          .set({ repositoryId: targetRepo.id })
          .where(eq(accountTable.id, githubAccount.id))

        return c.json({ success: true, message: 'Repository connected successfully' })
      }

      // If bot is only invited to the repo, make sure it is empty to avoid clearing an existing repo
      // We are relying on the fact that the commits route in the API will throw a 409 error if the repository is empty
      try {
        await octokit.request('GET /repos/{owner}/{repo}/commits', {
          owner: targetRepo.owner,
          repo: targetRepo.name,
        })
        return c.json({
          error: 'Repository must be empty to connect. Please create a new empty repository, or contact support if you are sure you want to connect this one.',
        }, 400)
      } catch (error) {
        if (!(
          error instanceof RequestError &&
          error.status === 409 &&
          (error.response?.data as { message: string }).message === 'Git Repository is empty.'
        )) {
          throw error
        }
      }

      // Repository is empty, accept the invitation
      const botOctokit = getBotOctokit()
      await botOctokit.request('PATCH /user/repository_invitations/{invitation_id}', {
        invitation_id: parseInt(targetRepo.invitationId),
      })

      // Update the user's account with the repository ID
      await db
        .update(accountTable)
        .set({ repositoryId: targetRepo.id })
        .where(eq(accountTable.id, githubAccount.id))

      return c.json({
        success: true,
        message: 'Repository invitation accepted and connected successfully',
      })
    } catch (error) {
      console.error('Error connecting GitHub repository:', error)
      return c.json({ error: 'Failed to connect repository' }, 500)
    }
  })

  .post('/github/disconnect-repo', zValidator('json', z.strictObject({
    repoId: z.string(),
  })), async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const { repoId } = c.req.valid('json')

    try {
      // Get user's GitHub account
      const [githubAccount] = await db
        .select()
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'github'),
        ))
        .limit(1)

      if (!githubAccount) {
        return c.json({ error: 'GitHub account not linked' }, 400)
      }

      // Check if the repoId matches the user's current repositoryId
      if (githubAccount.repositoryId !== repoId) {
        return c.json({ error: 'Repository ID does not match current linked repository' }, 400)
      }

      // Set the repositoryId to null
      await db
        .update(accountTable)
        .set({ repositoryId: null })
        .where(eq(accountTable.id, githubAccount.id))

      return c.json({ success: true, message: 'Repository disconnected successfully' })
    } catch (error) {
      console.error('Error disconnecting GitHub repository:', error)
      return c.json({ error: 'Failed to disconnect repository' }, 500)
    }
  })
