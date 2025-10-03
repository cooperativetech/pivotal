import { eq, and, desc } from 'drizzle-orm'
import { z } from 'zod'

import { Agent, run } from './agent-sdk'
import db from '../db/engine'
import type { SlackMessage, SlackUser } from '../db/schema/main'
import type { TopicWithState } from '@shared/api-types'
import { slackMessageTable, slackUserTable } from '../db/schema/main'
import {
  tsToDate,
  organizeMessagesByChannelAndThread,
  replaceUserMentions,
  getChannelDescription,
  formatTimestampWithTimezone,
} from '../utils'
import { getShortTimezoneFromIANA } from '@shared/utils'
import { WorkflowType } from '@shared/api-types'

const AnalyzeTopicRes = z.strictObject({
  relevantTopicId: z.string().optional().nullable(),
  suggestedNewTopic: z.string().optional().nullable(),
  workflowType: WorkflowType.optional().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})
type AnalyzeTopicRes = z.infer<typeof AnalyzeTopicRes>

const topicAnalysisAgent = new Agent({
  name: 'topicAnalysisAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0, // Reduce temperature for consistency
  },
  outputType: AnalyzeTopicRes,
  instructions: `You are a topic analysis assistant. Your job is to analyze whether a given message is relevant to any existing topics or if it could form the basis for a new topic.

## Your Task
Given a list of existing topics and a new message, determine:
1. Whether the message is relevant to any existing topics
2. Which specific topic it relates to (if any)
3. If it doesn't relate to existing topics, whether it could form a new topic
4. Your confidence level (0-1) in this assessment

## Analysis Criteria
- A message is relevant to a topic if it:
  - Directly discusses information relevant to the topic summary
  - Is part of an ongoing conversation that is already part of the topic
  - Provides new information that extends the topic

- Consider the topic metadata:
  - How recently the topic was updated (more recent = potentially more relevant)
  - The set of users involved (message sender involved = potentially more relevant)
  - If the message's userId is in the topic's userIds list, it's more likely to be relevant

- A message could form a new topic if it:
  - Introduces a distinct subject or task not covered by existing topics
  - Has sufficient substance (not just small talk or meta-conversation)
  - Could generate follow-up discussion
  - Is coherent enough to summarize into a topic

## Workflow Type Classification
When suggesting a new topic, also classify its workflow type:
- "scheduling": The topic involves planning, organizing, or scheduling meetings, events, or activities (e.g., "plan lunch", "schedule meeting", "organize team event")
- "meeting-prep": The topic involves preparing for an upcoming meeting by gathering updates, creating agendas, or collecting input from participants (e.g., "prepare agenda for tomorrow's standup", "gather updates for the quarterly review", "compile discussion topics for the team meeting")
- "queries": The topic is focused on answering questions, retrieving information, or checking statuses (e.g., "is my calendar connected?", "what was the summary from Monday's meeting?", "did Parker reply?")
- "other": All other topics that don't fit the above categories

## Response Format
You must respond with ONLY a JSON object - no additional text, markdown formatting, or explanations. Return ONLY valid JSON that can be parsed directly.

The JSON structure must be:
{
  "relevantTopicId": "e55a48d1-bf81-4f7f-8848-d0f69b74ff85",  // Include the full UUID from "Topic ID: ..." if message is relevant to existing topic
  "suggestedNewTopic": "New topic summary",                   // Include only if relevantTopicId is not populated
  "workflowType": "scheduling",                               // Include only when suggestedNewTopic is present. Must be "scheduling", "meeting-prep", "queries", or "other"
  "confidence": 0.85,                                         // Confidence level between 0 and 1
  "reasoning": "Brief explanation"                            // One sentence explaining the decision
}

IMPORTANT:
- If the message relates to an existing topic, you MUST use the exact UUID string shown in "Topic ID: ..." (e.g., "e55a48d1-bf81-4f7f-8848-d0f69b74ff85")
- Do NOT use numbers or any other identifier - only the full UUID
- Return ONLY the JSON object. Do not include any text before or after the JSON.`,
})

export async function analyzeTopicRelevance(topics: TopicWithState[], message: SlackMessage, userMap: Map<string, SlackUser>, botUserId: string): Promise<AnalyzeTopicRes> {
  // Get calling user's timezone
  const callingUser = await db
    .select()
    .from(slackUserTable)
    .where(eq(slackUserTable.id, message.userId))
    .limit(1)
  const callingUserTimezone = callingUser[0]?.tz || 'UTC'

  // Get channel information for descriptive display
  const channelDescription = await getChannelDescription(message.channelId, userMap)

  // Fetch recent messages for each topic in the same channel
  const topicMessagesMap = new Map<string, SlackMessage[]>()

  for (const topic of topics) {
    // Get all messages for this topic in the current channel
    const topicMessages = await db
      .select()
      .from(slackMessageTable)
      .where(
        and(
          eq(slackMessageTable.topicId, topic.id),
          eq(slackMessageTable.channelId, message.channelId),
        ),
      )
      .orderBy(desc(slackMessageTable.timestamp))

    // Separate thread messages and channel messages
    const threadMessages: SlackMessage[] = []
    const channelMessages: SlackMessage[] = []

    for (const prevMsg of topicMessages) {
      if (message.threadTs) {
        const prevMsgThreadTs = prevMsg.threadTs || prevMsg.rawTs
        if (prevMsgThreadTs === message.threadTs) {
          threadMessages.push(prevMsg)
        }
      }
      channelMessages.push(prevMsg)
    }

    // Get most recent 5 from thread and channel (avoiding duplicates)
    const recentThreadMessages = threadMessages.slice(0, 5)
    const recentChannelMessages = channelMessages
      .slice(0, 5)
      .filter((msg) => !recentThreadMessages.some((tm) => tm.id === msg.id))

    // Combine and sort by timestamp
    const combinedMessages = [...recentThreadMessages, ...recentChannelMessages]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    topicMessagesMap.set(topic.id, combinedMessages)
  }

  const userPrompt = `Your name in conversations: ${userMap.get(botUserId)?.realName || 'Assistant'}

${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.values())
  .map((u) => u.realName)
  .filter(Boolean)
  .sort()
  .join(', ')}

` : ''}Existing topics:
${(await Promise.all(topics.map(async (topic) => {
  const ageInDays = Math.floor((Date.now() - new Date(topic.state.createdAt).getTime()) / (1000 * 60 * 60 * 24))
  const userNames = topic.state.userIds.map((id) => {
    const name = userMap.get(id)?.realName
    return name || 'Unknown User'
  }).join(', ')

  // Get recent messages for this topic
  const recentMessages = topicMessagesMap.get(topic.id) || []
  const messagesFormatted = recentMessages.length > 0
    ? `\n   Recent messages in this channel:\n${(await organizeMessagesByChannelAndThread(recentMessages, callingUserTimezone)).split('\n').map((line) => '   ' + line).join('\n')}`
    : ''
  return `Topic ID: ${topic.id}
   Summary: ${topic.state.summary}
   Users involved: [${userNames}]
   Last updated: ${ageInDays === 0 ? 'today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'} ago`}${messagesFormatted}`
}))).join('\n\n')}

Message to analyze:
From: ${userMap.get(message.userId)?.realName || 'Unknown User'} (Timezone: ${callingUser[0]?.tz ? getShortTimezoneFromIANA(callingUser[0].tz) : 'UTC'})
Channel: ${channelDescription}${message.threadTs ? `\nIn thread: [${formatTimestampWithTimezone(tsToDate(message.threadTs), callingUserTimezone)}]` : ''}
Timestamp: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone)}
Text: "${replaceUserMentions(message.text, userMap)}"

Analyze whether this message is relevant to any of the existing topics or if it could form the basis for a new topic.`

  try {
    const result = await run(topicAnalysisAgent, userPrompt)
    if (!result.finalOutput) {
      throw new Error('No finalOutput generated')
    }
    return result.finalOutput
  } catch (error) {
    console.error('Error in analyzeTopicRelevance:', error)
  }

  // Return a safe default response
  return {
    confidence: 0,
    reasoning: '',
  }
}
