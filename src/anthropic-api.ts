import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'

import db from './db/engine'
import { Topic, slackMessageTable, SlackMessage } from './db/schema/main'
import { eq, and, desc } from 'drizzle-orm'
import { tsToDate } from './shared/utils'

const openrouter = createOpenRouter({ apiKey: process.env.PV_OPENROUTER_API_KEY })

// Helper function to replace user ID mentions with user names
function replaceUserMentions(text: string, userMap?: Map<string, string>): string {
  if (!userMap || userMap.size === 0) {
    return text
  }

  // Replace all <@USERID> patterns with the user's name
  return text.replace(/<@([A-Z0-9]+)>/g, (match, userId: string) => {
    const userName = userMap.get(userId)
    return userName ? `<@${userName}>` : match
  })
}

export async function analyzeTopicRelevance(topics: Topic[], message: SlackMessage, userMap?: Map<string, string>, botUserId?: string): Promise<{
  relevantTopicId?: string
  suggestedNewTopic?: string
  workflowType?: 'scheduling' | 'other'
  confidence: number
  reasoning: string
}> {
  // Get message thread_ts if it exists
  let messageThreadTs: string | undefined
  if (message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string') {
    messageThreadTs = message.raw.thread_ts
  }

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

    for (const msg of topicMessages) {
      // Check if message is in the same thread
      if (messageThreadTs && msg.raw && typeof msg.raw === 'object') {
        const msgThreadTs = 'thread_ts' in msg.raw && typeof msg.raw.thread_ts === 'string'
          ? msg.raw.thread_ts
          : ('ts' in msg.raw && typeof msg.raw.ts === 'string' ? msg.raw.ts : null)

        if (msgThreadTs === messageThreadTs) {
          threadMessages.push(msg)
        }
      }
      channelMessages.push(msg)
    }

    // Get most recent 5 from thread and channel (avoiding duplicates)
    const recentThreadMessages = threadMessages.slice(0, 5)
    const recentChannelMessages = channelMessages
      .slice(0, 5)
      .filter(msg => !recentThreadMessages.some(tm => tm.id === msg.id))

    // Combine and sort by timestamp
    const combinedMessages = [...recentThreadMessages, ...recentChannelMessages]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    topicMessagesMap.set(topic.id, combinedMessages)
  }

  const systemPrompt = `You are a topic analysis assistant. Your job is to analyze whether a given message is relevant to any existing topics or if it could form the basis for a new topic.

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
- "other": All other topics that don't involve scheduling or planning activities

## Response Format
You must respond with ONLY a JSON object - no additional text, markdown formatting, or explanations. Return ONLY valid JSON that can be parsed directly.

The JSON structure must be:
{
  "relevantTopicId": "topic-id-2",           // Include only if message is relevant to existing topic
  "suggestedNewTopic": "New topic summary",  // Include only if existingTopicId is not populated
  "workflowType": "scheduling",              // Include only when suggestedNewTopic is present. Must be "scheduling" or "other"
  "confidence": 0.85,                        // Confidence level between 0 and 1
  "reasoning": "Brief explanation"           // One sentence explaining the decision
}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.`

  // Create a map for bot name
  const botName = botUserId && userMap?.get(botUserId) ? userMap.get(botUserId) : 'Assistant'

  const userPrompt = `${botUserId ? `Your name in conversations: ${botName}

` : ''}${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.values()).sort().join(', ')}

` : ''}Existing topics:
${topics.map((topic, i) => {
  const ageInDays = Math.floor((Date.now() - new Date(topic.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
  const userNames = topic.userIds.map(id => {
    const name = userMap?.get(id)
    return name || 'Unknown User'
  }).join(', ')

  // Get recent messages for this topic
  const recentMessages = topicMessagesMap.get(topic.id) || []
  const messagesFormatted = recentMessages.length > 0
    ? `\n   Recent messages in this channel:\n${organizeMessagesByChannelAndThread(recentMessages, userMap).split('\n').map(line => '   ' + line).join('\n')}`
    : ''
  return `${i + 1}. Topic ID: ${topic.id}
   Summary: ${topic.summary}
   Users involved: [${userNames}]
   Last updated: ${ageInDays === 0 ? 'today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'} ago`}${messagesFormatted}`
}).join('\n\n')}

Message to analyze:
From: ${userMap?.get(message.userId) || 'Unknown User'}
Channel: ${message.channelId}${messageThreadTs ? `\nIn thread: [${tsToDate(messageThreadTs).toLocaleString()}]` : ''}
Timestamp: ${new Date(message.timestamp).toLocaleString()}
Text: "${replaceUserMentions(message.text, userMap)}"

Analyze whether this message is relevant to any of the existing topics or if it could form the basis for a new topic.`

  try {
    const res = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      maxTokens: 1024,
      temperature: 0, // Lower temperature for more consistent analysis
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    })

    // Parse the JSON response
    const analysis = JSON.parse(res.text) as {
      relevantTopicId?: string
      suggestedNewTopic?: string
      workflowType?: 'scheduling' | 'other'
      confidence: number
      reasoning: string
    }

    return analysis
  } catch (error) {
    console.error('Error in analyzeTopicRelevance:', error)
    // Return a safe default response
    return {
      confidence: 0,
      reasoning: '',
    }
  }
}

function organizeMessagesByChannelAndThread(messages: SlackMessage[], userMap?: Map<string, string>): string {
  if (messages.length === 0) {
    return 'No previous messages'
  }

  // Group messages by channel and thread
  const messageGroups = messages.reduce((acc, msg) => {
    const channelKey = msg.channelId
    let threadKey = '0'
    if (msg.raw && typeof msg.raw === 'object' && 'thread_ts' in msg.raw && typeof msg.raw.thread_ts === 'string') {
      threadKey = msg.raw.thread_ts
    } else if (msg.raw && typeof msg.raw === 'object' && 'ts' in msg.raw && typeof msg.raw.ts === 'string') {
      threadKey = msg.raw.ts // Use message timestamp as thread key if no thread timestamp found
    }

    if (!acc[channelKey]) {
      acc[channelKey] = {}
    }
    if (!acc[channelKey][threadKey]) {
      acc[channelKey][threadKey] = []
    }

    acc[channelKey][threadKey].push(msg)
    return acc
  }, {} as Record<string, Record<string, SlackMessage[]>>)

  // Sort messages within each group by timestamp and format output
  let output = ''
  Object.entries(messageGroups).forEach(([channelId, threads]) => {
    output += `Channel ${channelId}:\n`

    // Sort threads by threadId converted to number
    const sortedThreads = Object.entries(threads).sort(([aId], [bId]) => {
      return Number(aId) - Number(bId)
    })

    sortedThreads.forEach(([threadId, messages]) => {
      // Only show thread header if there's more than one message in the thread
      if (messages.length > 1) {
        // Convert threadId (timestamp string) to formatted date
        output += `  Thread [${tsToDate(threadId).toLocaleString()}]:\n`
      }

      // Sort messages by timestamp
      const sortedMessages = messages.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )

      sortedMessages.forEach(msg => {
        // Adjust indent based on whether we're showing thread header
        const indent = messages.length > 1 ? '    ' : '  '
        const userName = userMap?.get(msg.userId) || 'Unknown User'
        const processedText = replaceUserMentions(msg.text, userMap)
        output += `${indent}[${new Date(msg.timestamp).toLocaleString()}] ${userName}: "${processedText}"\n`
      })
    })
    output += '\n'
  })

  return output.trim()
}

export async function scheduleNextStep(message: SlackMessage, topic: Topic, previousMessages: SlackMessage[], userMap?: Map<string, string>, botUserId?: string): Promise<{
  action: 'identify_users' | 'gather_constraints' | 'finalize' | 'complete' | 'other'
  replyMessage: string
  updateUserIds?: string[]
  updateUserNames?: string[] // Names that will be mapped back to userIds
  updateSummary?: string
  markTopicInactive?: boolean
  messagesToUsers?: {
    userIds: string[] // List of users to send this identical message to
    userNames?: string[] // Names that will be mapped back to userIds
    text: string
  }[]
  groupMessage?: string
  reasoning: string
}> {
  const systemPrompt = `You are a scheduling assistant that helps coordinate meetings and events. Your job is to determine the next step in the scheduling process and generate appropriate responses.

## Scheduling Workflow
The scheduling process follows these steps:
1. **Identify Users**: Determine who needs to be included in the scheduling
2. **Gather Constraints**: Collect availability and preferences from each user individually
3. **Finalize**: Once consensus is found, get confirmation from all participants on the chosen time

## Current Context
You will receive:
- The current message from a user
- The topic information including all users currently involved
- The topic summary describing what needs to be scheduled

## Your Task
Based on the current state, determine:
1. Which step of the workflow we're in
2. What action to take next
3. Generate the appropriate message(s)

## Action Types
- "identify_users": Need to determine who should be involved
  - Return updateUserNames array with the COMPLETE list of user names who should be involved in the topic going forward
  - IMPORTANT: Use the exact full names from the User Directory (e.g., "John Smith", not "John" or "Smith")
  - This replaces the existing user list, not appends to it
  - Return replyMessage asking about missing participants or confirming who will be included

- "gather_constraints": Need to collect availability from users
  - IMPORTANT: Start by asking the initial requesting user (the person who created the topic) about their scheduling constraints first
  - Only after getting the requester's constraints should you move on to asking other participants
  - Return messagesToUsers array with personalized availability requests (sent as 1-1 DMs)
  - Each message can be sent to one or multiple users (via userIds array) - same message as individual DMs
  - Return replyMessage acknowledging the constraint gathering process
  - CRITICAL: If your replyMessage says you will reach out to others, you MUST include the corresponding messagesToUsers in the same response
  - Never promise to contact users without actually including those messages in messagesToUsers array
  - Can gather from multiple users simultaneously or focus on one at a time (but always start with the requester)
  - Continue gathering until a consensus time emerges from the constraints

- "finalize": Ready to confirm the consensus time
  - Return groupMessage with the agreed time for final confirmation (sent to shared channel)
  - Only use when you have identified a time that works for all participants
  - Return replyMessage with confirmation

- "complete": Scheduling is done
  - Return groupMessage with final details
  - Return replyMessage confirming completion
  - Set markTopicInactive: true to indicate this topic should be marked inactive

- "other": Miscellaneous actions needed
  - Use for: asking clarification, providing updates, handling edge cases
  - Return replyMessage with the appropriate response
  - Optionally return messagesToUsers for private 1-1 clarifications (sent as DMs)
  - Optionally return groupMessage for updates to all users in shared channel
  - Optionally return updateUserNames if users need to be added/removed (use exact names from User Directory)

## Important Guidelines
- Keep messages conversational and friendly
- Respect privacy - don't share individual constraints publicly
- Only move to finalize when you've found a time that works for all participants
- Consider timezone differences if mentioned
- Use common sense for activity timing (coffee = morning/afternoon, dinner = evening)
- Update the topic summary (updateSummary) whenever new information clarifies or changes the meeting details
- messagesToUsers always sends private 1-1 DMs; groupMessage always sends to a shared channel with all topic users
- ALWAYS use exact full names from the User Directory when specifying updateUserNames or userNames in messagesToUsers
- CRITICAL: Always execute promised actions immediately - if you say you'll reach out to users, include those messages in the current response
- Never defer actions to a future response - everything mentioned in replyMessage must be actioned in the same response

## Response Format
Return ONLY a JSON object with the appropriate fields based on the action:
{
  "action": "identify_users|gather_constraints|finalize|complete|other",
  "replyMessage": "Message text",  // REQUIRED: Reply to the message sender
  "updateUserNames": ["John Smith", "Jane Doe"],  // Complete list of user names (MUST use exact names from User Directory)
  "updateSummary": "Updated topic summary",  // Optional for ANY action - updates topic when details change
  "markTopicInactive": true,      // Optional: Include when action is "complete" to mark topic as inactive
  "messagesToUsers": [             // Array of INDIVIDUAL 1-1 DM messages to send privately
    {
      "userNames": ["John Smith"],     // Send this message as individual DM to each user in list (MUST use exact names from User Directory)
      "text": "Hi! What times work for you this week?"
    },
    {
      "userNames": ["Jane Doe", "Bob Wilson"],  // Each user gets the same message as a private DM (MUST use exact names from User Directory)
      "text": "Quick check - are you available Tuesday afternoon?"
    }
  ],
  "groupMessage": "Message text",  // Sends to SHARED CHANNEL with ALL users in topic's userIds list (finalize/complete)
  "reasoning": "Brief explanation of the decision"
}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.`

  // Create a map for bot name
  const botName = botUserId && userMap?.get(botUserId) ? userMap.get(botUserId) : 'Assistant'

  const userPrompt = `${botUserId ? `Your name in conversations: ${botName}

` : ''}${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.values()).sort().join(', ')}

` : ''}Current Topic:
ID: ${topic.id}
Summary: ${topic.summary}
Users involved: ${topic.userIds.map(id => {
  const name = userMap?.get(id)
  return name || 'Unknown User'
}).join(', ')}
Created: ${new Date(topic.createdAt).toLocaleString()}
Last updated: ${new Date(topic.updatedAt).toLocaleString()}

Previous Messages in this Topic:
${organizeMessagesByChannelAndThread(previousMessages, userMap)}

Message To Reply To:
From: ${userMap?.get(message.userId) || 'Unknown User'}
Text: "${replaceUserMentions(message.text, userMap)}"
Channel: ${message.channelId}${
  message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string'
    ? `\nThread: [${tsToDate(message.raw.thread_ts).toLocaleString()}]`
    : ''
}
Timestamp: ${new Date(message.timestamp).toLocaleString()}

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.`

  console.log(userPrompt)

  try {
    const res = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      maxTokens: 1024,
      temperature: 0.7,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    })

    // Parse the JSON response
    const nextStep = JSON.parse(res.text) as {
      action: 'identify_users' | 'gather_constraints' | 'finalize' | 'complete' | 'other'
      replyMessage: string
      updateUserIds?: string[]
      updateUserNames?: string[]
      updateSummary?: string
      markTopicInactive?: boolean
      messagesToUsers?: {
        userIds: string[]
        userNames?: string[]
        text: string
      }[]
      groupMessage?: string
      reasoning: string
    }

    return nextStep
  } catch (error) {
    console.error('Error in scheduleNextStep:', error)
    // Return a safe default response
    return {
      action: 'other',
      replyMessage: 'I encountered an error processing the scheduling request.',
      reasoning: 'Error occurred during processing',
    }
  }
}
