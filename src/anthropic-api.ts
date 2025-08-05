import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import { GroupChat } from './shared/api-types'
import { Topic, SlackMessage } from './db/schema/main'

const openrouter = createOpenRouter({ apiKey: process.env.PV_OPENROUTER_API_KEY })

export async function takeAction(chat: GroupChat, currentUserId: string): Promise<string> {
  // Build the system prompt based on the pasted format
  const systemPrompt = `You are a helpful planning agent that helps groups find optimal meeting times. You're activated when someone uses "\\plan [activity] [timeframe]" in a group chat.

## Your Role
You open individual 1:1 chats with each group member to gather availability while maintaining a shared, live-updating availability overview. Your goal is to quickly find the best meeting time through strategic questioning.

## Core Principles
- **Speed first**: Ask ONE high-yield question that maximally eliminates impossible time slots
- **Natural conversation**: People are texting casually - be conversational and efficient
- **Respect constraints**: If someone says a time is definitely busy, that's a hard constraint
- **Privacy-preserving**: Share availability windows publicly, keep personal reasons private
- **Common sense scheduling**: Use LLM reasoning (coffee at 10am not 3am, dinner not breakfast time)
- **Assumption**: Start conversations with "I'm assuming everyone's in PST - if anyone's not, let me know now"

## Public Progress Updates
After each person responds, post a public update to the group:
- **Multiple people remaining**: "Still waiting on 2 people to respond. Current available windows: Tuesday morning/afternoon, Wednesday morning."
- **One person remaining**: "Still waiting on Ben to respond. Top candidate times: Tuesday 10am, Tuesday 2pm, Wednesday 11am."
- **All responded**: Present final options with backup times

## Your Process
1. **Identify blockers**: People with limited availability become the primary constraint
2. **Strategic questioning**: Focus on the most constrained people first, then validate with others
3. **Smart scheduling**: Use common sense for activity timing (coffee = morning/afternoon, dinner = evening, etc.)
4. **Present solutions**: Always include 2-3 backup times in case primary choice falls through
5. **Calendar follow-up**: Offer to send calendar invites once time is confirmed
6. **Conflict resolution**: If no perfect time exists:
   - Ask constrained people: "This works for everyone else - is your conflict firm or any chance you could make it work?"
   - Find the best compromise that balances everyone's needs
   - Don't be pushy, but do one gentle follow-up for hard constraints

## Groupchat Protocol
**When to respond in main group:**
- Initial \\plan trigger: "I'll help you plan that. Opening 1:1 chats with everyone now."
- Progress updates: "Still waiting on 2 people. Current windows: Tuesday/Wednesday morning."
- Final recommendations: Present the agreed times + backups

**When NOT to respond in main group:**
- Random chatting/off-topic conversation
- Individual availability details (keep those in 1:1s)

**Privacy rules:**
- Keep personal reasons private ("funeral", "in-laws")
- Share only availability windows publicly
- Maintain context across all chats but don't leak specifics

## Response Format
You must respond with ONLY a JSON object - no additional text, markdown formatting, or explanations. Return ONLY valid JSON that can be parsed directly.

The JSON structure must be:
{
  "messages": [
    {
      "recipient": "group" | "<userId>",  // "group" for group chat, or specific userId for individual chat
      "text": "Your message here"
    }
  ],
  "updatePublicContext": "Optional new public context if it needs updating"
}

Examples:
- To send a group message: {"recipient": "group", "text": "I'll help you plan that. Opening 1:1 chats with everyone now."}
- To send to a specific user: {"recipient": "user123", "text": "Hi! What times this week won't work for you?"}
- To update context: {"updatePublicContext": "Planning coffee meeting for Tuesday 10am at Blue Bottle"}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.

## Current Context
- **Group Chat History**: [Will be populated with actual chat history]
- **Individual Chat History**: [Will be populated with your conversation]

Remember: Your job is to make scheduling painless and fast while respecting everyone's real constraints and using common sense about appropriate meeting times!`

  // Build the user prompt with chat context
  let userPrompt = ''

  // Add public context if available
  if (chat.publicContext) {
    userPrompt += `Public Context: ${chat.publicContext}\n\n`
  }

  // Add group chat history
  if (chat.groupChatHistory.length > 0) {
    userPrompt += 'Group Chat History:\n'
    chat.groupChatHistory.forEach(msg => {
      const timestamp = new Date(msg.createdAt).toLocaleString()
      userPrompt += `[${timestamp}] User ${msg.userId}: ${msg.text}\n`
    })
    userPrompt += '\n'
  }

  // Add individual chat history with the current user
  const userHistory = chat.individualChatHistory[currentUserId] || []
  if (userHistory.length > 0) {
    userPrompt += `Your conversation with User ${currentUserId}:\n`
    userHistory.forEach(msg => {
      const timestamp = new Date(msg.createdAt).toLocaleString()
      const sender = msg.userId === 'assistant' ? 'You' : `User ${msg.userId}`
      userPrompt += `[${timestamp}] ${sender}: ${msg.text}\n`
    })
  }

  // Add instruction to return JSON
  userPrompt += '\n\nBased on the context above, respond with ONLY a JSON object containing your actions. Do not include any text before or after the JSON. Return only valid, parseable JSON.'

  try {
    const res = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      maxTokens: 8192,
      temperature: 1,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    })

    return res.text
  } catch (error) {
    console.error('Error in takeAction:', error)
    return JSON.stringify({
      messages: [{
        recipient: currentUserId,
        text: 'I apologize, but I encountered an error processing your request.',
      }],
    })
  }
}

export async function analyzeTopicRelevance(topics: Topic[], message: SlackMessage, userMap?: Map<string, string>, botUserId?: string): Promise<{
  relevantTopicId?: string
  suggestedNewTopic?: string
  workflowType?: 'scheduling' | 'other'
  confidence: number
  reasoning: string
}> {
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

  const userPrompt = `${botUserId ? `Bot User ID: ${botUserId} (this is you in the conversations)

` : ''}${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries()).map(([id, name]) => `${id}: ${name}`).join('\n')}

` : ''}Existing topics:
${topics.map((topic, i) => {
  const ageInDays = Math.floor((Date.now() - new Date(topic.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
  const userNames = topic.userIds.map(id => {
    const name = userMap?.get(id)
    return name ? `${name} (${id})` : id
  }).join(', ')
  return `${i + 1}. Topic ID: ${topic.id}
   Summary: ${topic.summary}
   Users involved: [${userNames}]
   Last updated: ${ageInDays === 0 ? 'today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'} ago`}`
}).join('\n\n')}

Message to analyze:
User: ${userMap?.get(message.userId) || message.userId} (${message.userId})
Channel: ${message.channelId}
Timestamp: ${new Date(message.timestamp).toLocaleString()}
Text: "${message.text}"

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
    const threadKey = (msg.raw && typeof msg.raw === 'object' && 'thread_ts' in msg.raw && typeof msg.raw.thread_ts === 'string')
      ? msg.raw.thread_ts
      : 'main'

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

    Object.entries(threads).forEach(([threadId, messages]) => {
      if (threadId !== 'main') {
        output += `  Thread ${threadId}:\n`
      }

      // Sort messages by timestamp
      const sortedMessages = messages.sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )

      sortedMessages.forEach(msg => {
        const indent = threadId !== 'main' ? '    ' : '  '
        const userName = userMap?.get(msg.userId) || msg.userId
        output += `${indent}[${new Date(msg.timestamp).toLocaleString()}] ${userName} (${msg.userId}): "${msg.text}"\n`
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
  updateSummary?: string
  messagesToUsers?: {
    userIds: string[] // List of users to send this identical message to
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
  - Return updateUserIds array with the COMPLETE list of users who should be involved in the topic going forward
  - This replaces the existing user list, not appends to it
  - Return replyMessage asking about missing participants or confirming who will be included

- "gather_constraints": Need to collect availability from users
  - Return messagesToUsers array with personalized availability requests (sent as 1-1 DMs)
  - Each message can be sent to one or multiple users (via userIds array) - same message as individual DMs
  - Return replyMessage acknowledging the constraint gathering process
  - Can gather from multiple users simultaneously or focus on one at a time
  - Continue gathering until a consensus time emerges from the constraints

- "finalize": Ready to confirm the consensus time
  - Return groupMessage with the agreed time for final confirmation (sent to shared channel)
  - Only use when you have identified a time that works for all participants
  - Return replyMessage with confirmation

- "complete": Scheduling is done
  - Return groupMessage with final details
  - Return replyMessage confirming completion

- "other": Miscellaneous actions needed
  - Use for: asking clarification, providing updates, handling edge cases
  - Return replyMessage with the appropriate response
  - Optionally return messagesToUsers for private 1-1 clarifications (sent as DMs)
  - Optionally return groupMessage for updates to all users in shared channel
  - Optionally return updateUserIds if users need to be added/removed

## Important Guidelines
- Keep messages conversational and friendly
- Respect privacy - don't share individual constraints publicly
- Only move to finalize when you've found a time that works for all participants
- Consider timezone differences if mentioned
- Use common sense for activity timing (coffee = morning/afternoon, dinner = evening)
- Update the topic summary (updateSummary) whenever new information clarifies or changes the meeting details
- messagesToUsers always sends private 1-1 DMs; groupMessage always sends to a shared channel with all topic users

## Response Format
Return ONLY a JSON object with the appropriate fields based on the action:
{
  "action": "identify_users|gather_constraints|finalize|complete|other",
  "replyMessage": "Message text",  // REQUIRED: Reply to the message sender
  "updateUserIds": ["user1", "user2"],  // Complete list of users for the topic (replaces existing)
  "updateSummary": "Updated topic summary",  // Optional for ANY action - updates topic when details change
  "messagesToUsers": [             // Array of INDIVIDUAL 1-1 DM messages to send privately
    {
      "userIds": ["user123"],     // Send this message as individual DM to each user in list
      "text": "Hi! What times work for you this week?"
    },
    {
      "userIds": ["user456", "user789"],  // Each user gets the same message as a private DM
      "text": "Quick check - are you available Tuesday afternoon?"
    }
  ],
  "groupMessage": "Message text",  // Sends to SHARED CHANNEL with ALL users in topic's userIds list (finalize/complete)
  "reasoning": "Brief explanation of the decision"
}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.`

  const userPrompt = `${botUserId ? `Bot User ID: ${botUserId} (this is you in the conversations)

` : ''}${userMap && userMap.size > 0 ? `User Directory: {
  ${Array.from(userMap.entries()).map(([id, name]) => `${id}: ${name}`).join(',\n  ')}
}

` : ''}Current Topic:
ID: ${topic.id}
Summary: ${topic.summary}
Users involved: ${topic.userIds.map(id => {
  const name = userMap?.get(id)
  return name ? `${name} (${id})` : id
}).join(', ')}
Created: ${new Date(topic.createdAt).toLocaleString()}
Last updated: ${new Date(topic.updatedAt).toLocaleString()}

Previous Messages in this Topic:
${organizeMessagesByChannelAndThread(previousMessages, userMap)}

Message To Reply To:
From user: ${userMap?.get(message.userId) || message.userId} (${message.userId})
Text: "${message.text}"
Channel: ${message.channelId}${
  message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string'
    ? `\nThread: ${message.raw.thread_ts}`
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
      updateSummary?: string
      messagesToUsers?: {
        userIds: string[]
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
