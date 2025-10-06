import { App } from 'octokit'
import { Octokit } from '@octokit/core'
import { simpleGit } from 'simple-git'
import fs from 'fs/promises'
import path from 'path'
import type { GithubRepo } from '@shared/api-types'

export async function getInstallationOctokit(installationId: string): Promise<Octokit> {
  const app = new App({
    appId: process.env.PV_GITHUB_APP_ID!,
    privateKey: process.env.PV_GITHUB_APP_PRIVATE_KEY!,
  })
  const octokit = await app.getInstallationOctokit(parseInt(installationId))
  return octokit
}

export function getBotOctokit(): Octokit {
  const token = process.env.PV_GITHUB_BOT_ACCESS_TOKEN
  if (!token) {
    throw new Error('PV_GITHUB_BOT_ACCESS_TOKEN environment variable is not set')
  }
  return new Octokit({ auth: token })
}

export function getAppOctokit(): Octokit {
  const app = new App({
    appId: process.env.PV_GITHUB_APP_ID!,
    privateKey: process.env.PV_GITHUB_APP_PRIVATE_KEY!,
  })
  return app.octokit
}

// TODO: support if user installed an installation on their user account rather than an org
export async function getOrgName(installationId: string): Promise<string> {
  const octokit = await getInstallationOctokit(installationId)
  const { data: installation } = await octokit.request('GET /app/installations/{installation_id}', {
    installation_id: parseInt(installationId),
  })
  if (!installation.account || !('login' in installation.account)) {
    throw new Error(`No account found for installation ${installationId}`)
  }
  return installation.account.login
}

export async function getOrgRepoInfo(installationId: string, repoId: string | null): Promise<{ linkedRepo: GithubRepo | null, linkableRepos: GithubRepo[] }> {
  const repos = await getBotAccessibleRepos(installationId)
  const linkedRepo = repos.find((repo) => repo.id === repoId) || null
  const linkableRepos = linkedRepo ? [] : repos
  return { linkedRepo, linkableRepos }
}

async function getInstallationRepoIds(installationId: string): Promise<Set<string>> {
  const octokit = await getInstallationOctokit(installationId)
  const installationRepoIds = new Set<string>()
  let page = 1
  let hasMore = true
  while (hasMore) {
    const { data } = await octokit.request('GET /installation/repositories', {
      per_page: 100,
      page,
    })
    if (data.repositories.length < 100) {
      hasMore = false
    }

    for (const repo of data.repositories) {
      installationRepoIds.add(repo.id.toString())
    }
    page += 1
  }
  return installationRepoIds
}

async function getBotUserRepos(): Promise<GithubRepo[]> {
  const botOctokit = getBotOctokit()
  const repositories: GithubRepo[] = []
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
  return repositories
}

async function getBotUserInvitations(): Promise<GithubRepo[]> {
  const botOctokit = getBotOctokit()
  const repositories: GithubRepo[] = []
  let page = 1
  let hasMore = true
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

export async function getBotAccessibleRepos(installationId: string): Promise<GithubRepo[]> {
  // Get all data in parallel
  const [installationRepoIds, botRepos, botInvitations] = await Promise.all([
    getInstallationRepoIds(installationId),
    getBotUserRepos(),
    getBotUserInvitations(),
  ])

  // Combine bot repos and invitations
  const repositories = [...botRepos, ...botInvitations]

  // Filter to only include repositories that are in the installation
  return repositories.filter((repo) => installationRepoIds.has(repo.id))
}

export async function getOrInitGitRepo(installationId: string, repoId: string): Promise<string> {
  // Define the repository directory path
  const projectRoot = process.cwd()
  const repoDir = path.join(projectRoot, '.context-repos', repoId)

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

  // Get repository URL from getBotAccessibleRepositories
  const { linkedRepo } = await getOrgRepoInfo(installationId, repoId)
  if (!linkedRepo) {
    throw new Error(`Repository with ID ${repoId} not found in installation repositories`)
  }
  const githubUrl = `https://github.com/${linkedRepo.fullName}.git`

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
