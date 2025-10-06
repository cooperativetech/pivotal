import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { RequestError } from '@octokit/request-error'
import { and, eq, inArray, desc } from 'drizzle-orm'
import { z } from 'zod'
import db from '../db/engine'
import { slackUserTable, slackMessageTable } from '../db/schema/main'
import { accountTable, slackAppInstallationTable, memberTable, organizationTable, githubAppInstallationTable, userTable } from '../db/schema/auth'
import type { Organization } from '../db/schema/auth'
import type { CalendarEvent, GithubRepo } from '@shared/api-types'
import { auth } from '../auth'
import { dumpTopic, getTopics, getTopicWithState, updateTopicState } from '../utils'
import { getLinkedSlackAccount } from '../integrations/slack'
import { getLinkedGoogleAccount, getGoogleCalendar } from '../integrations/google'
import { getInstallationOctokit, getBotOctokit, getBotAccessibleRepos, getOrgName, getOrgRepoInfo, getAppOctokit } from '../integrations/github'

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
      const user = {
        id: sessionUser.id,
        email: sessionUser.email,
        name: sessionUser.name,
      }

      const slackAccount = await getLinkedSlackAccount(sessionUser.id)
      const googleAccount = await getLinkedGoogleAccount(sessionUser.id)

      // Type hint required since better-auth return type doesn't include custom slackTeamId column
      const [rawOrganization] = (await auth.api.listOrganizations({
        headers: c.req.raw.headers,
      })) as Organization[]
      if (!rawOrganization) {
        await auth.api.signOut({ headers: c.req.raw.headers })
        throw new Error(`No organization found for user ${sessionUser.id}`)
      }

      // Check if bot is installed for this organization
      const [slackAppInstallation] = await db.select()
        .from(slackAppInstallationTable)
        .where(eq(slackAppInstallationTable.teamId, rawOrganization.slackTeamId))
        .limit(1)

      // Check if GitHub app is installed for this organization
      const [githubAppInstallation] = await db.select()
        .from(githubAppInstallationTable)
        .where(eq(githubAppInstallationTable.slackTeamId, rawOrganization.slackTeamId))
        .limit(1)

      let githubOrgName: string | null = null
      let githubLinkedRepo: GithubRepo | null = null
      let githubLinkableRepos: GithubRepo[] = []
      if (githubAppInstallation) {
        githubOrgName = await getOrgName(githubAppInstallation.installationId)
        const repoInfo = await getOrgRepoInfo(
          githubAppInstallation.installationId,
          githubAppInstallation.repositoryId,
        )
        githubLinkedRepo = repoInfo.linkedRepo
        githubLinkableRepos = repoInfo.linkableRepos
      }

      // Get the name of the user who connected the org and repository
      let githubOrgConnectedByUserName: string | null = null
      let githubRepoConnectedByUserName: string | null = null

      if (githubAppInstallation?.createdByUserId) {
        const [createdByUser] = await db.select({ name: userTable.name })
          .from(userTable)
          .where(eq(userTable.id, githubAppInstallation.createdByUserId))
          .limit(1)
        githubOrgConnectedByUserName = createdByUser?.name || null
      }

      if (githubAppInstallation?.repositoryConnectedByUserId) {
        const [connectedByUser] = await db.select({ name: userTable.name })
          .from(userTable)
          .where(eq(userTable.id, githubAppInstallation.repositoryConnectedByUserId))
          .limit(1)
        githubRepoConnectedByUserName = connectedByUser?.name || null
      }

      const organization = {
        id: rawOrganization.id,
        name: rawOrganization.name,
        slackTeamId: rawOrganization.slackTeamId,
        slackAppInstalled: !!slackAppInstallation,
        githubOrgName,
        githubLinkedRepo,
        githubLinkableRepos,
        githubOrgConnectedByUserName,
        githubRepoConnectedByUserName,
      }

      return c.json({
        user,
        slackAccount,
        googleAccount,
        organization,
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
      // Get user's organization to access slackTeamId
      const [organization] = (await auth.api.listOrganizations({
        headers: c.req.raw.headers,
      })) as Organization[]
      if (!organization) {
        return c.json({ error: 'No organization found' }, 404)
      }

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

      // Get all topics for this team
      const allTopics = await getTopics(organization.slackTeamId)

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

  .post('/topics/:topicId/status', zValidator('json', z.object({ isActive: z.boolean() })), async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const { topicId } = c.req.param()
    const { isActive } = c.req.valid('json')

    try {
      const [organization] = (await auth.api.listOrganizations({
        headers: c.req.raw.headers,
      })) as Organization[]

      if (!organization) {
        return c.json({ error: 'No organization found' }, 404)
      }

      const topic = await getTopicWithState(topicId)

      if (topic.slackTeamId !== organization.slackTeamId) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      const [latestMessage] = await db
        .select({ id: slackMessageTable.id })
        .from(slackMessageTable)
        .where(eq(slackMessageTable.topicId, topicId))
        .orderBy(desc(slackMessageTable.timestamp))
        .limit(1)

      const messageId = latestMessage?.id ?? topic.state.createdByMessageId

      if (!messageId) {
        return c.json({ error: 'Unable to determine message context for state change' }, 400)
      }

      const updatedTopic = await updateTopicState(topic, { isActive }, messageId)

      return c.json({ topic: updatedTopic })
    } catch (error) {
      console.error('Error updating topic status:', error)
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
      const [linkedSlackAccount] = await db.select()
        .from(accountTable)
        .where(and(
          eq(accountTable.userId, sessionUser.id),
          eq(accountTable.providerId, 'slack'),
        ))
        .limit(1)

      // Return only data visible to the current user's Slack accounts (messages/channels only)
      const userSlackId = linkedSlackAccount.accountId
      const topicData = await dumpTopic(topicId, { visibleToUserId: userSlackId })

      // If the user has no messages visible, they can't access this topic
      if (topicData.messages.length < 1) {
        return c.json({ error: 'Forbidden' }, 403)
      }

      // Get the upcoming week of the user's calendar
      const userCalendars: Record<string, CalendarEvent[] | null> = {}
      const now = new Date()
      const nowPlusOneWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      userCalendars[userSlackId] = await getGoogleCalendar(userSlackId, now, nowPlusOneWeek)

      return c.json({
        topicData,
        userCalendars,
      })
    } catch (error) {
      console.error('Error fetching topic data:', error)
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404)
      }
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
      // Get user's organization and GitHub app installation
      const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
        .from(memberTable)
        .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
        .where(eq(memberTable.userId, sessionUser.id))
        .limit(1)
      if (!userOrg) {
        return c.json({ error: 'Organization not found' }, 400)
      }

      const [githubAppInstallation] = await db.select()
        .from(githubAppInstallationTable)
        .where(eq(githubAppInstallationTable.slackTeamId, userOrg.slackTeamId))
        .limit(1)
      if (!githubAppInstallation) {
        return c.json({ error: 'GitHub app not installed' }, 400)
      }

      // Get target repo
      const repos = await getBotAccessibleRepos(githubAppInstallation.installationId)
      const targetRepo = repos.find((r) => r.id === repoId)
      if (!targetRepo) {
        return c.json({ error: 'Bot does not have access to this repository' }, 403)
      }

      // If bot already has access (not just invitation)
      if (targetRepo.invitationId === null) {
        // Update the GitHub app installation with the repository ID
        await db
          .update(githubAppInstallationTable)
          .set({
            repositoryId: targetRepo.id,
            repositoryConnectedByUserId: sessionUser.id,
            repositoryConnectedAt: new Date(),
          })
          .where(eq(githubAppInstallationTable.slackTeamId, userOrg.slackTeamId))

        return c.json({ success: true, message: 'Repository connected successfully' })
      }

      // If bot is only invited to the repo, make sure it is empty to avoid clearing an existing repo
      // We are relying on the fact that the commits route in the API will throw a 409 error if the repository is empty
      try {
        const octokit = await getInstallationOctokit(githubAppInstallation.installationId)
        if (!octokit) {
          return c.json({ error: 'Invalid GitHub app installation' }, 401)
        }

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

      // Update the GitHub app installation with the repository ID
      await db
        .update(githubAppInstallationTable)
        .set({
          repositoryId: targetRepo.id,
          repositoryConnectedByUserId: sessionUser.id,
          repositoryConnectedAt: new Date(),
        })
        .where(eq(githubAppInstallationTable.slackTeamId, userOrg.slackTeamId))

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
      // Get user's organization
      const [userOrg] = await db.select({ slackTeamId: organizationTable.slackTeamId })
        .from(memberTable)
        .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
        .where(eq(memberTable.userId, sessionUser.id))
        .limit(1)
      if (!userOrg) {
        return c.json({ error: 'Organization not found' }, 400)
      }

      // Get GitHub app installation
      const [githubAppInstallation] = await db.select()
        .from(githubAppInstallationTable)
        .where(eq(githubAppInstallationTable.slackTeamId, userOrg.slackTeamId))
        .limit(1)
      if (!githubAppInstallation) {
        return c.json({ error: 'GitHub app not installed' }, 400)
      }

      // Check if the repoId matches the current linked repository
      if (githubAppInstallation.repositoryId !== repoId) {
        return c.json({ error: 'Repository ID does not match current linked repository' }, 400)
      }

      // Clear the repository fields
      await db
        .update(githubAppInstallationTable)
        .set({
          repositoryId: null,
          repositoryConnectedByUserId: null,
          repositoryConnectedAt: null,
        })
        .where(eq(githubAppInstallationTable.slackTeamId, userOrg.slackTeamId))

      return c.json({ success: true, message: 'Repository disconnected successfully' })
    } catch (error) {
      console.error('Error disconnecting GitHub repository:', error)
      return c.json({ error: 'Failed to disconnect repository' }, 500)
    }
  })

  .post('/github/uninstall-app', async (c) => {
    const sessionUser = c.get('user')
    if (!sessionUser) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    try {
      // Get user's organization and GitHub app installation in a single query
      const [result] = await db
        .select({
          slackTeamId: organizationTable.slackTeamId,
          installationId: githubAppInstallationTable.installationId,
        })
        .from(memberTable)
        .innerJoin(organizationTable, eq(memberTable.organizationId, organizationTable.id))
        .innerJoin(githubAppInstallationTable, eq(githubAppInstallationTable.slackTeamId, organizationTable.slackTeamId))
        .where(eq(memberTable.userId, sessionUser.id))
        .limit(1)

      if (!result) {
        return c.json({ error: 'Organization or GitHub app installation not found' }, 400)
      }

      // Call GitHub API to delete the installation
      const appOctokit = getAppOctokit()
      await appOctokit.request('DELETE /app/installations/{installation_id}', {
        installation_id: parseInt(result.installationId),
      })

      // Delete the installation record from the database
      await db
        .delete(githubAppInstallationTable)
        .where(eq(githubAppInstallationTable.slackTeamId, result.slackTeamId))

      return c.json({ success: true, message: 'GitHub app uninstalled successfully' })
    } catch (error) {
      console.error('Error uninstalling GitHub app:', error)
      return c.json({ error: 'Failed to uninstall GitHub app' }, 500)
    }
  })

  .get(
    '/google/authorize',
    zValidator('query', z.strictObject({
      callbackURL: z.string().optional(),
      errorCallbackURL: z.string().optional(),
    })),
    async (c) => {
      const sessionUser = c.get('user')

      // If not logged in, redirect to login screen
      if (!sessionUser) {
        return c.redirect('/login?redirectTo=googleAuthorize')
      }

      const { callbackURL, errorCallbackURL } = c.req.valid('query')

      // If logged in, initiate the account linking process with linkSocialAccount,
      // and redirect the user to google's authorization flow
      const { url } = await auth.api.linkSocialAccount({
        body: {
          provider: 'google',
          ...(callbackURL && { callbackURL }),
          ...(errorCallbackURL && { errorCallbackURL }),
        },
        headers: c.req.raw.headers,
      })
      return c.redirect(url)
    },
  )
