import { Octokit } from '@octokit/core'
import { createOAuthUserAuth } from '@octokit/auth-oauth-user'
import { and, eq } from 'drizzle-orm'
import db from '../db/engine'
import { auth } from '../auth'
import { accountTable } from '../db/schema/auth'
import { simpleGit } from 'simple-git'
import fs from 'fs/promises'
import path from 'path'

export async function getOctokit(userId: string, accountPk: string): Promise<Octokit | null> {
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

export function getBotOctokit(): Octokit {
  const token = process.env.PV_GITHUB_BOT_ACCESS_TOKEN
  if (!token) {
    throw new Error('PV_GITHUB_BOT_ACCESS_TOKEN environment variable is not set')
  }
  return new Octokit({ auth: token })
}

interface BotRepository {
  id: string
  name: string
  owner: string
  fullName: string
  invitationId: string | null
}

interface GithubAccount {
  accountId: string
  username: string
  orgName: string | null
  linkedRepo: BotRepository | null
  linkableRepos: BotRepository[]
}

export async function getLinkedGithubAccount(userId: string): Promise<GithubAccount | null> {
  // Get linked Github account from auth account table (only one)
  const linkedGithubAccount = await db.select()
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
      linkedRepo,
      linkableRepos,
    }
  } catch (error) {
    console.error(`Failed to fetch GitHub profile for account ${account.id}:`, error)
    return null
  }
}

export async function getAllBotRepositories(): Promise<BotRepository[]> {
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

export async function getOrInitGitRepo(repositoryId: string): Promise<string> {
  // Define the repository directory path
  const projectRoot = process.cwd()
  const repoDir = path.join(projectRoot, '.context-repos', repositoryId)

  // Check if the folder exists, create if not
  try {
    await fs.access(repoDir)
  } catch {
    // Directory doesn't exist, create it
    await fs.mkdir(repoDir, { recursive: true })
    console.log(`Created directory: ${repoDir}`)
  }

  // Init the git repo (re-initializing an existing repo is harmless)
  const git = simpleGit(repoDir)
  await git.init()

  // Configure the repo to use the correct environment variables for authentication
  await git.addConfig(
    'credential.helper',
    '!f() { echo "username=${PV_GITHUB_BOT_USERNAME}"; echo "password=${PV_GITHUB_BOT_ACCESS_TOKEN}"; }; f',
  )

  // Configure the repo to always rebase rather than merge, and to set up remotes automatically
  await git.addConfig('pull.rebase', 'true')
  await git.addConfig('push.autosetupremote', 'true')

  // Get bot's GitHub profile to set user.email and user.name
  const botOctokit = getBotOctokit()
  const { data: botProfile } = await botOctokit.request('GET /user')
  await git.addConfig('user.email', botProfile.email || `${botProfile.login}@users.noreply.github.com`)
  await git.addConfig('user.name', botProfile.name || botProfile.login)
  console.log(`Configured git identity: ${botProfile.name || botProfile.login} <${botProfile.email || `${botProfile.login}@users.noreply.github.com`}>`)

  // Get repository URL from getAllBotRepositories
  const botRepositories = await getAllBotRepositories()
  const repository = botRepositories.find((repo) => repo.id === repositoryId)
  if (!repository) {
    throw new Error(`Repository with ID ${repositoryId} not found in bot repositories`)
  }
  const githubUrl = `https://github.com/${repository.fullName}.git`

  // Check current remotes and set/update if needed
  const remotes = await git.getRemotes(true)
  const originRemote = remotes.find((remote) => remote.name === 'origin')

  if (!originRemote) {
    // No origin remote exists, add it
    await git.addRemote('origin', githubUrl)
    console.log(`Added remote 'origin': ${githubUrl}`)
  } else if (originRemote.refs.fetch !== githubUrl && originRemote.refs.push !== githubUrl) {
    // Remote exists but points to wrong URL, throw an error
    throw new Error(`Remote origin is ${JSON.stringify(originRemote.refs)} but should be ${githubUrl}`)
  }

  // Make sure we're on the main branch
  try {
    await git.checkout('main')
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error &&
        error.message == "error: pathspec 'main' did not match any file(s) known to git\n") {
      console.log('Ignoring error due to empty git repository')
    } else {
      throw error
    }
  }

  // Pull latest changes from the remote
  try {
    await git.pull('origin', 'main')
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error &&
        error.message == "couldn't find remote ref main") {
      console.log('Ignoring error due to empty remote repository')
    } else {
      throw error
    }
  }

  return repoDir
}
