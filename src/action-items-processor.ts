import { eq } from 'drizzle-orm'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'

import type { MeetingArtifact } from './db/schema/main'
import db from './db/engine'
import { meetingArtifactTable } from './db/schema/main'
import { githubAppInstallationTable } from './db/schema/auth'
import { getTopicWithState } from './utils'
import { Agent, run, tool } from './agents/agent-sdk'
import { editOrgActionItems } from './agents/org-context/action-items'
import { getOrInitGitRepo, getOrgRepoInfo } from './integrations/github'

interface ActionItemsResult {
  commitSha?: string
  summary?: string
  repoFullName?: string
  error?: string
  githubEnabled: boolean
}

// Output types matching tool responses
const EditActionItemsOutput = z.strictObject({
  commitSha: z.string(),
  summary: z.string(),
})

const ReportActionItemsOutput = z.strictObject({
  summary: z.string(),
})

// Pass-through tool for non-GitHub mode
const reportActionItems = tool({
  name: 'reportActionItems',
  description: 'Report the action items found in the meeting transcript',
  parameters: ReportActionItemsOutput,
  execute: (params) => params,
})

function createActionItemsAgentWithGithub(currentActionItems: string) {
  const instructions = `You are an action items parser that analyzes meeting transcripts to extract and update action items in the organization's GitHub repository.

## Current Action Items

${currentActionItems}

## Your Task
Analyze the meeting transcript and:
1. Review the current action items shown above
2. Identify new action items mentioned in the transcript
3. Find updates to existing action items (completions, assignee changes, etc.)
4. Call editOrgActionItems with a bullet-point list of all changes to make

## Action Items Guidelines
- Extract clear, actionable tasks assigned to specific people
- Look for completion confirmations (e.g., "I finished X", "X is done")
- Track assignee changes (e.g., "I'll take over Y from Z")

IMPORTANT: Call the editOrgActionItems tool to update the action items. The tool will return the result.`

  return new Agent({
    name: 'actionItemsParserWithGithub',
    model: 'anthropic/claude-sonnet-4',
    toolUseBehavior: { stopAtToolNames: ['editOrgActionItems'] },
    modelSettings: {
      maxTokens: 2048,
      temperature: 0.7,
      toolChoice: 'required',
    },
    tools: [editOrgActionItems],
    outputType: EditActionItemsOutput,
    instructions,
  })
}

function createActionItemsAgentWithoutGithub() {
  const instructions = `You are an action items parser that analyzes meeting transcripts to extract action items.

## Your Task
Analyze the meeting transcript and extract all action items mentioned, including:
- The task description
- Who is assigned to it
- Any deadlines mentioned

## Response Format
Call the reportActionItems tool with a summary of action items found.
Format the summary as a list of action items: • @person Task 1 • @person Task 2

IMPORTANT: Call the reportActionItems tool with your findings.`

  return new Agent({
    name: 'actionItemsParserWithoutGithub',
    model: 'anthropic/claude-sonnet-4',
    toolUseBehavior: { stopAtToolNames: ['reportActionItems'] },
    modelSettings: {
      maxTokens: 2048,
      temperature: 0.7,
      toolChoice: 'required',
    },
    tools: [reportActionItems],
    outputType: ReportActionItemsOutput,
    instructions,
  })
}

async function fetchCurrentActionItems(installationId: string, repositoryId: string): Promise<string> {
  const repoPath = await getOrInitGitRepo(installationId, repositoryId)
  const actionItemsPath = path.join(repoPath, 'action-items.md')
  try {
    const contents = await fs.readFile(actionItemsPath, 'utf-8')
    return contents
  } catch {
    return 'Action items file not found. This will be the first set of action items.'
  }
}

export async function processActionItemsForArtifact(
  artifact: MeetingArtifact,
  transcriptText: string,
): Promise<ActionItemsResult> {
  try {
    // Get topic to access slackTeamId
    const topic = await getTopicWithState(artifact.topicId)

    // Check if GitHub integration exists for the team
    const [githubAppInstallation] = await db.select()
      .from(githubAppInstallationTable)
      .where(eq(githubAppInstallationTable.slackTeamId, topic.slackTeamId))
      .limit(1)

    const githubEnabled = !!githubAppInstallation?.repositoryId

    // Create agent based on GitHub integration status
    let agent
    let repoFullName: string | undefined
    if (githubEnabled && githubAppInstallation?.installationId && githubAppInstallation?.repositoryId) {
      // Fetch repository info and current action items from GitHub
      const { linkedRepo } = await getOrgRepoInfo(
        githubAppInstallation.installationId,
        githubAppInstallation.repositoryId,
      )
      repoFullName = linkedRepo?.fullName

      const currentActionItems = await fetchCurrentActionItems(
        githubAppInstallation.installationId,
        githubAppInstallation.repositoryId,
      )

      agent = createActionItemsAgentWithGithub(currentActionItems)
    } else {
      agent = createActionItemsAgentWithoutGithub()
    }

    // Format meeting context for tool parameters
    const meetingTitle = artifact.summary || 'Meeting'
    const meetingDate = artifact.startTime.toISOString().split('T')[0] // YYYY-MM-DD

    // Build context message
    const meetingContext = `Meeting: ${meetingTitle}
Date: ${meetingDate}
Participants: (from topic users)

When calling editOrgActionItems, pass these values:
- meetingTitle: "${meetingTitle}"
- meetingDate: "${meetingDate}"

Transcript:
${transcriptText}`

    // Run agent
    const result = await run(agent, meetingContext, {
      context: { topic },
    })

    if (!result.finalOutput) {
      throw new Error('No output generated from action items agent')
    }

    const toolResult = result.finalOutput

    // Extract commitSha and summary from tool result
    const commitSha = 'commitSha' in toolResult ? toolResult.commitSha : undefined
    const summary = toolResult.summary

    // Update database
    await db
      .update(meetingArtifactTable)
      .set({
        actionItemsProcessedAt: new Date(),
        actionItemsCommitSha: commitSha,
        actionItemsError: null,
        updatedAt: new Date(),
      })
      .where(eq(meetingArtifactTable.id, artifact.id))

    return {
      commitSha,
      summary,
      repoFullName,
      githubEnabled,
    }
  } catch (error) {
    console.error(`[ActionItemsProcessor] Failed to process action items for artifact ${artifact.id}:`, error)

    // Update database with error
    const errorMessage = error instanceof Error ? error.message : String(error)
    await db
      .update(meetingArtifactTable)
      .set({
        actionItemsProcessedAt: new Date(),
        actionItemsError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(meetingArtifactTable.id, artifact.id))

    return {
      error: errorMessage,
      githubEnabled: false,
    }
  }
}

export function buildActionItemsMessage(result: ActionItemsResult): string {
  if (result.error) {
    return '⚠️ Failed to process action items from meeting'
  }

  if (result.githubEnabled && result.commitSha && result.summary) {
    const commitUrl = result.repoFullName
      ? `https://github.com/${result.repoFullName}/commit/${result.commitSha}`
      : null

    return `📝 Action items updated from meeting

${result.summary}

${commitUrl ? `View changes: ${commitUrl}` : 'View changes in your GitHub repository'}`
  }

  if (!result.githubEnabled && result.summary) {
    return `📝 Action items from meeting:

${result.summary}

💡 Connect GitHub to automatically track action items in your repo`
  }

  return '📝 No action items identified in this meeting'
}
