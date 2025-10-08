import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { RunContext } from '../agent-sdk'
import { tool } from '../agent-sdk'
import db from '../../db/engine'
import { githubAppInstallationTable } from '../../db/schema/auth'
import type { ConversationContext } from '../conversation-utils'
import { getOrInitGitRepo } from '../../integrations/github.ts'
import fs from 'fs/promises'
import path from 'path'
import { updateFile } from './update-file.ts'
import { generateCommitSummary } from './commit-summary.ts'
import simpleGit from 'simple-git'

export const getOrgActionItems = tool({
  name: 'getOrgActionItems',
  description: 'Get the current set of action items for the organization.',
  parameters: z.strictObject({ a: z.string() }), // The tool call fails with a JSON parse error if you specify no arguments
  execute: async (_params, runContext?: RunContext<ConversationContext>): Promise<string> => {
    console.log('Tool called: getOrgActionItems')
    if (!runContext) throw new Error('runContext not provided')
    const { topic } = runContext.context

    // Get GitHub app installation for this team
    const [githubAppInstallation] = await db.select()
      .from(githubAppInstallationTable)
      .where(eq(githubAppInstallationTable.slackTeamId, topic.slackTeamId))
      .limit(1)

    if (!githubAppInstallation?.repositoryId) {
      return 'Organization context not available'
    }

    const repoPath = await getOrInitGitRepo(githubAppInstallation.installationId, githubAppInstallation.repositoryId)

    try {
      const actionItemsPath = path.join(repoPath, 'action-items.md')
      const contents = await fs.readFile(actionItemsPath, 'utf-8')
      return contents
    } catch {
      return 'Action items not available'
    }
  },
})

export const editOrgActionItems = tool({
  name: 'editOrgActionItems',
  description: 'Edit the action items for the organization by applying a set of updates (e.g., adding, removing, or modifying items).',
  parameters: z.strictObject({
    updates: z.string().describe('A string describing the updates to make to the action items (e.g., bullet point list of changes)'),
    meetingTitle: z.string().optional().nullable().describe('Optional meeting title for context'),
    meetingDate: z.string().optional().nullable().describe('Optional meeting date for context'),
  }),
  execute: async (params, runContext?: RunContext<ConversationContext>): Promise<{ commitSha: string, summary: string }> => {
    console.log('Tool called: editActionItems')
    if (!runContext) throw new Error('runContext not provided')
    const { topic } = runContext.context

    // Get GitHub app installation for this team
    const [githubAppInstallation] = await db.select()
      .from(githubAppInstallationTable)
      .where(eq(githubAppInstallationTable.slackTeamId, topic.slackTeamId))
      .limit(1)

    if (!githubAppInstallation?.repositoryId) {
      throw new Error('Organization context not available')
    }

    const repoPath = await getOrInitGitRepo(githubAppInstallation.installationId, githubAppInstallation.repositoryId)
    const filePath = 'action-items.md'
    const actionItemsPath = path.join(repoPath, filePath)

    try {
      await fs.access(actionItemsPath)
    } catch {
      await fs.writeFile(actionItemsPath, '# Action Items\n\n')
    }

    const diffs = await updateFile(repoPath, filePath, params.updates)

    // Generate commit summary from the updates and diffs
    const commitSummary = await generateCommitSummary(params.updates, diffs)

    // Build commit message body with meeting context if available
    const bodyParts = []
    if (params.meetingTitle || params.meetingDate) {
      const meetingContext = []
      if (params.meetingTitle) meetingContext.push(params.meetingTitle)
      if (params.meetingDate) meetingContext.push(params.meetingDate)
      bodyParts.push(`Source: ${meetingContext.join(' - ')}`)
      bodyParts.push('')
    }
    bodyParts.push(params.updates)

    // Create commit message with summary and body
    const commitMessage = `${commitSummary}\n\n${bodyParts.join('\n')}`

    // Run git commands to commit and push
    const git = simpleGit(repoPath)
    await git.add(filePath)
    await git.commit(commitMessage)
    await git.push()

    // Extract commit SHA from the push result
    const commitSha = await git.revparse(['HEAD'])

    return {
      commitSha: commitSha.trim(),
      summary: commitMessage,
    }
  },
})
