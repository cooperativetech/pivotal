import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText, tool } from 'ai'
import { z } from 'zod'

import db from './db/engine'
import { Topic, slackMessageTable, SlackMessage, topicTable, slackUserTable, slackChannelTable } from './db/schema/main'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { tsToDate, organizeMessagesByChannelAndThread, replaceUserMentions } from './utils'
import { getShortTimezoneFromIANA, mergeCalendarWithOverrides } from '@shared/utils'
import { type CalendarEvent } from '@shared/api-types'
import { generateGoogleAuthUrl, getUserCalendarStructured, isCalendarConnected, getUserContext, updateUserContext } from './calendar-service'
import { findCommonFreeTime, UserProfile, convertCalendarEventsToUserProfile } from './tools/time_intersection'

const openrouter = createOpenRouter({ apiKey: process.env.PV_OPENROUTER_API_KEY })

interface AnalyzeTopicRes {
  relevantTopicId?: string
  suggestedNewTopic?: string
  workflowType?: 'scheduling' | 'other'
  confidence: number
  reasoning: string
}

/**
 * Parse JSON from response text, handling code block wrappers
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResponseJSON(responseText: string): any {
  // Strip JSON code block wrapper if it exists
  const cleanedText = responseText.replace(/^```(?:json)?\n?|\n?```$/g, '')
  return JSON.parse(cleanedText)
}

async function getChannelDescription(
  channelId: string,
  userMap: Map<string, string>,
  botUserId: string,
): Promise<string> {
  const [channel] = await db
    .select()
    .from(slackChannelTable)
    .where(eq(slackChannelTable.id, channelId))
    .limit(1)

  // Get timezone information for channel users
  const channelUserIds = channel?.userIds || []
  const userTimezones = new Map<string, string>()
  if (channelUserIds.length > 0) {
    const users = await db
      .select()
      .from(slackUserTable)
      .where(inArray(slackUserTable.id, channelUserIds))
    for (const user of users) {
      if (user.tz) {
        userTimezones.set(user.id, user.tz)
      }
    }
  }

  let channelDescription = `Channel ${channelId}`
  if (channel && channel.userIds) {
    const filteredUserIds = channel.userIds.filter((id: string) => id !== botUserId)
    const channelUserNames = filteredUserIds.map((id: string) => {
      const name = userMap.get(id) || 'Unknown User'
      const tz = userTimezones.get(id)
      return tz ? `${name} (${getShortTimezoneFromIANA(tz)})` : name
    })

    if (filteredUserIds.length === 1) {
      channelDescription = `DM with ${channelUserNames[0]}`
    } else if (filteredUserIds.length > 1) {
      channelDescription = `Group channel with ${channelUserNames.join(', ')}`
    }
  }

  return channelDescription
}

export async function analyzeTopicRelevance(topics: Topic[], message: SlackMessage, userMap: Map<string, string>, botUserId: string): Promise<AnalyzeTopicRes> {
  // Get calling user's timezone
  const callingUser = await db
    .select()
    .from(slackUserTable)
    .where(eq(slackUserTable.id, message.userId))
    .limit(1)
  const callingUserTimezone = callingUser[0]?.tz || 'UTC'

  // Get channel information for descriptive display
  const channelDescription = await getChannelDescription(message.channelId, userMap, botUserId)

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

  const userPrompt = `Your name in conversations: ${userMap.get(botUserId) || 'Assistant'}

${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.values()).sort().join(', ')}

` : ''}Existing topics:
${(await Promise.all(topics.map(async (topic, i) => {
  const ageInDays = Math.floor((Date.now() - new Date(topic.updatedAt).getTime()) / (1000 * 60 * 60 * 24))
  const userNames = topic.userIds.map((id) => {
    const name = userMap.get(id)
    return name || 'Unknown User'
  }).join(', ')

  // Get recent messages for this topic
  const recentMessages = topicMessagesMap.get(topic.id) || []
  const messagesFormatted = recentMessages.length > 0
    ? `\n   Recent messages in this channel:\n${(await organizeMessagesByChannelAndThread(recentMessages, topic.userIds, botUserId, callingUserTimezone)).split('\n').map((line) => '   ' + line).join('\n')}`
    : ''
  return `${i + 1}. Topic ID: ${topic.id}
   Summary: ${topic.summary}
   Users involved: [${userNames}]
   Last updated: ${ageInDays === 0 ? 'today' : `${ageInDays} day${ageInDays === 1 ? '' : 's'} ago`}${messagesFormatted}`
}))).join('\n\n')}

Message to analyze:
From: ${userMap.get(message.userId) || 'Unknown User'} (Timezone: ${callingUser[0]?.tz ? getShortTimezoneFromIANA(callingUser[0].tz) : 'UTC'})
Channel: ${channelDescription}${message.threadTs ? `\nIn thread: [${formatTimestampWithTimezone(tsToDate(message.threadTs), callingUserTimezone)}]` : ''}
Timestamp: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone)}
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
    const analysis = parseResponseJSON(res.text) as {
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

// Helper function to get user timezones
async function getUserTimezones(userIds: string[]): Promise<Map<string, string>> {
  const timezoneMap = new Map<string, string>()

  if (userIds.length === 0) return timezoneMap

  const users = await db
    .select()
    .from(slackUserTable)
    .where(inArray(slackUserTable.id, userIds))

  for (const user of users) {
    if (user.tz) {
      timezoneMap.set(user.id, user.tz)
    }
  }

  return timezoneMap
}

// Helper function to format timestamp with timezone
function formatTimestampWithTimezone(timestamp: Date | string, timezone?: string): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
  const formatted = date.toLocaleString('en-US', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  // Get abbreviated timezone
  const tzAbbr = timezone ? getShortTimezoneFromIANA(timezone) : 'UTC'

  return `${formatted} (${tzAbbr})`
}

export async function scheduleNextStep(
  message: SlackMessage,
  topic: Topic,
  previousMessages: SlackMessage[],
  userMap: Map<string, string>,
  botUserId: string,
  prevToolResults?: {
    toolsCalled: string[]
    userPromptSuffix: string
  },
): Promise<{
  replyMessage: string
  updateSummary?: string
  markTopicInactive?: boolean
  messagesToUsers?: {
    userIds: string[] // List of users to send this identical message to
    userNames?: string[] // Names that will be mapped back to userIds
    text: string
    includeCalendarButtons?: boolean // Whether to include calendar connection buttons
  }[]
  groupMessage?: string
  reasoning: string
  toolUsed?: boolean // true if findFreeSlots tool was called
}> {
  // If user is explicitly asking for calendar connection, send link immediately
  const userRequestingCalendar = message.text.toLowerCase().includes('calendar') &&
    (message.text.toLowerCase().includes('link') ||
     message.text.toLowerCase().includes('connect') ||
     message.text.toLowerCase().includes('send me'))

  if (userRequestingCalendar) {
    const authUrl = generateGoogleAuthUrl(message.userId)

    return {
      replyMessage: `Here's your Google Calendar connection link:

${authUrl}

This will allow me to check your availability automatically when scheduling. If you'd rather not connect your calendar, just let me know and I'll ask for your availability manually instead.`,
      reasoning: 'User explicitly requested calendar connection link',
      toolUsed: false,
    }
  }


  // Get timezone information for all users
  const allUserIds = Array.from(new Set([...topic.userIds, message.userId]))
  const userTimezones = await getUserTimezones(allUserIds)
  const callingUserTimezone = userTimezones.get(message.userId) || 'UTC'

  // Get channel information for descriptive display
  const channelDescription = await getChannelDescription(message.channelId, userMap, botUserId)
  const systemPrompt = `You are a scheduling assistant that helps coordinate meetings and events. Your job is to determine the next step in the scheduling process and generate appropriate responses.

## Important Timezone Instructions
- ALWAYS include timezone abbreviations in parentheses next to ALL times you mention (e.g., "2pm (PST)" or "3:30pm (EST)")
- When responding to a user, ALWAYS use their timezone for suggested times
- Be explicit about timezone differences when they exist between participants
- When proposing times to multiple users with different timezones, show the time in each user's timezone

## Current Context
You will receive:
- The current message from a user
- The topic information including all users currently involved
- The topic summary describing what needs to be scheduled

## Your Task
Based on the current state, determine what tools to call (if any). If no more tools need to be called to gather additional context, generate the appropriate update to the topic summary and message(s) to users, if they are necessary to move the scheduling task along

## Subtasks that need be handled
1. Need to determine who should be involved
  - Use the updateUserNames tool to specify the COMPLETE list of user names who should be involved
  - IMPORTANT: Use the exact full names from the User Directory (e.g., "John Smith", not "John" or "Smith")
  - The tool will replace the existing user list, not append to it
  - Return replyMessage asking about missing participants or confirming who will be included

2. Need to collect initial time constraints from the initial message sender
  - This may often be specified in the initial message, e.g. schedule a meeting for _tomorrow_, or for _next week_
  - If this is unspecified by the initial message sender, ask them to specify
  - Once you determine the general time constraint for the meeting or event, add it to the topic summary. Ideally, this can be recorded very concretely with specific days and time ranges, including time zone information

3. Need to gather constraints from users
  - CRITICAL: If a user's calendar is connected (see Calendar Information: below), you do NOT need to ask them for availability. Instead, use the findFreeSlots tool to find the intersection of their availability with other users
  - CRITICAL: Before asking anyone for availability, check the conversation history to see who has already provided their availability/constraints
  - NEVER ask users for their availability again if they have already shared their schedule/constraints in previous messages
  - ONLY send availability requests to users who have NOT yet shared their availability, and who do not have a calendar connected
  - Return messagesToUsers array with personalized availability requests (sent as 1-1 DMs)
  - Each message can be sent to one or multiple users (via userIds array) - same message as individual DMs
  - Return replyMessage acknowledging the constraint gathering process
  - CRITICAL: If your replyMessage says you will reach out to others, you MUST include the corresponding messagesToUsers in the same response
  - Never promise to contact users without actually including those messages in messagesToUsers array
  - Can gather from multiple users simultaneously or focus on one at a time
  - Continue gathering until a consensus time emerges from the constraints

4. Ready to confirm the consensus time
  - Return groupMessage with the agreed time for final confirmation (sent to shared channel)
  - Only use when you have identified a time that works for all participants
  - Return replyMessage with confirmation

5. Scheduling is done
  - If all users reply that this time works for them, or they agree to cancel the meeting, set markTopicInactive: true to indicate this topic should be marked inactive

- Miscellaneous actions needed
  - Sometimes you need to ask for clarification, provide updates, or handle edge cases
  - Return replyMessage with the appropriate response
  - Optionally return messagesToUsers for private 1-1 clarifications (sent as DMs)
  - Optionally return groupMessage for updates to all users in shared channel
  - Can use updateUserNames tool if users need to be added/removed (use exact names from User Directory)

## Important Guidelines
- BE EXTREMELY CONCISE - keep all messages brief and to the point (1-2 sentences max unless proposing times)
- NEVER send messages that just confirm or acknowledge information - if someone tells you their availability, DON'T say "Thanks for sharing" or "I've noted that"
- CRITICAL: When you have calendar data for all users, ALWAYS use the findFreeSlots tool to find accurate available times before proposing any meeting slots
- NEVER propose times without first calling findFreeSlots - this ensures you only suggest times that actually work for everyone
- After calling findFreeSlots, propose 2-3 specific time slots from the results in your very next message
- Skip pleasantries and acknowledgments - get straight to business
- Respect privacy - don't share individual constraints publicly
- Only move to finalize when you've found a time that works for all participants
- ALWAYS include timezone abbreviations when mentioning times (e.g., "2pm (PST)")
- When users are in different timezones, show times in each user's local timezone
- Use common sense for activity timing (coffee = morning/afternoon, dinner = evening)
- Update the topic summary (updateSummary) whenever new information clarifies or changes the meeting details
- messagesToUsers always sends private 1-1 DMs; groupMessage always sends to a shared channel with all topic users
- ALWAYS use exact full names from the User Directory when specifying updateUserNames or userNames in messagesToUsers
- CRITICAL: Always execute promised actions immediately - if you say you'll reach out to users, include those messages in the current response
- Never defer actions to a future response - everything mentioned in replyMessage must be actioned in the same response
- AVOID REDUNDANT MESSAGES: Set replyMessage to empty string ("") when:
  - You've already sent requests to other users and are just waiting for responses
  - The user says "no response needed" or similar
  - You have nothing new or meaningful to add
  - You would just be acknowledging or confirming what was already said
- CRITICAL - STICK TO THE REQUESTED DAY: If users request a specific day (e.g., Tuesday), you MUST find a time on that day
  - NEVER suggest different days unless users explicitly ask for alternatives
  - If no common slot exists, ask each person about moving their "personal", "blocked-work", or non-critical meetings
  - Propose shorter meetings (30-45 minutes) if a full hour doesn't work
  - Keep trying different Tuesday times and flexibility options
  - Remember: Your job is to make Tuesday work, not to give up and switch days
- CRITICAL - HANDLING FREE TIME SPECIFICATIONS:
  - When a user says they are "free" at specific times (e.g., "I'm free 2-4pm"), assume they are BUSY for the rest of that ENTIRE day
  - Always create busy blocks for the ENTIRE day (12:00am-11:59pm in their timezone) EXCEPT for the times they said they're free
  - When calling updateUserCalendar, explicitly add both: 
    * Busy events for the blocked times (with free: false or omitted)
    * Free events for the available times (with free: true)
  - Example: If user says "I'm free Tuesday 2-4pm", create events for:
    * 12:00am-2:00pm (busy/blocked)
    * 2:00pm-4:00pm (free/available) 
    * 4:00pm-11:59pm (busy/blocked)
  - IMPORTANT: The opposite is NOT true - if a user says they are "busy" at specific times, DO NOT mark them as free elsewhere
    * Only add the busy events they specified, don't add any free events
    * Example: "I'm busy 2-3pm" → ONLY create: 2pm-3pm (busy). Do NOT add any free events.

## CRITICAL TOOL USAGE
You have access to THREE tools, but you can ONLY USE ONE per response:

1. **findFreeSlots**: Finds mathematically accurate free time slots
   - USE THIS before proposing any meeting times when you have calendar data
   - Pass the exact user names from the User Directory (e.g., "John Smith", "Jane Doe")
   - Optionally pass targetDate in YYYY-MM-DD format for the specific day to search (e.g., "2024-08-27" for next Tuesday)
   - Returns guaranteed-free slots that work for everyone
   - Never propose times without using this tool first

2. **updateUserNames**: Updates the list of users involved in the scheduling
   - USE THIS when you need to add/remove users from the topic (action: "identify_users")
   - Provide the COMPLETE list of user names (this replaces the existing list)
   - Use exact names from the User Directory

3. **updateUserCalendar**: Updates a user's calendar with manual availability overrides
   - USE THIS when a user explicitly tells you their availability or when they're busy/free
   - Pass the exact user name from the User Directory and a list of CalendarEvent objects
   - Events specify times when the user is busy (default) or free (if free: true is set)
   - IMPORTANT: When user says they're "free" at specific times, create busy blocks for the rest of the ENTIRE day
   - Example: "I'm free 2-4pm Tuesday" → Create: 12am-2pm (busy), 2pm-4pm (free: true), 4pm-11:59pm (busy)
   - BUT: When user says they're "busy" at specific times, ONLY add those busy blocks, don't add any free events
   - Example: "I'm busy 2-3pm Tuesday" → Create ONLY: 2pm-3pm (busy)
   - These overrides will be merged with their existing calendar, replacing any overlapping time periods
   - Useful when users don't have calendar connected or need to override their calendar

IMPORTANT: You can only call ONE tool per response. Choose the most appropriate one for your current action.
${prevToolResults ? `\n## PREVIOUS TOOL CALLS\nThe following tools have already been called: ${prevToolResults.toolsCalled.join(', ')}. The results are included in the user prompt. Do not call these tools again.` : ''}

## Response Format
If not calling tools, return ONLY a JSON object with the appropriate fields:
{
  "replyMessage": "Message text",  // REQUIRED field but can be empty string ("") when no response is needed
  "updateSummary": "Updated topic summary",  // Optional - updates topic when details change
  "markTopicInactive": true,      // Optional: Include to mark topic as inactive
  "messagesToUsers": [             // Array of INDIVIDUAL 1-1 DM messages to send privately
    {
      "userNames": ["John Smith"],     // Send this message as individual DM to each user in list (MUST use exact names from User Directory)
      "text": "Hi! What times work for you this week?",
      "includeCalendarButtons": true   // Optional: Include calendar connection buttons for availability requests
    },
    {
      "userNames": ["Jane Doe", "Bob Wilson"],  // Each user gets the same message as a private DM (MUST use exact names from User Directory)
      "text": "Quick check - are you available Tuesday afternoon?",
      "includeCalendarButtons": true   // Set to true when asking for availability/scheduling info
    }
  ],
  "groupMessage": "Message text",  // Sends to SHARED CHANNEL with ALL users in topic's userIds list (finalize/complete)
  "reasoning": "Brief explanation of the decision"
}

IMPORTANT: Return ONLY the JSON object. Do not include any text before or after the JSON.`

  const userPrompt = `Your name in conversations: ${userMap.get(botUserId) || 'Assistant'}

${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries())
  .sort((a, b) => a[1].localeCompare(b[1]))
  .map(([_userId, userName]) => userName)
  .join(', ')}

` : ''}Current Topic:
Summary: ${topic.summary}
Users involved (with timezones): ${topic.userIds.map((id) => {
  const name = userMap.get(id)
  const tz = userTimezones.get(id)
  return tz ? `${name || 'Unknown User'} (${getShortTimezoneFromIANA(tz)})` : (name || 'Unknown User')
}).join(', ')}
Created: ${formatTimestampWithTimezone(topic.createdAt, callingUserTimezone)}
Last updated: ${formatTimestampWithTimezone(topic.updatedAt, callingUserTimezone)}

Previous Messages in this Topic:
${await organizeMessagesByChannelAndThread(previousMessages, topic.userIds, botUserId, callingUserTimezone)}

Calendar Information:
${await Promise.all(topic.userIds.map(async (userId) => {
  const userName = userMap.get(userId) || 'Unknown User'
  try {
    const isConnected = await isCalendarConnected(userId)
    if (isConnected) {
      return `${userName}: Calendar is connected`
    }
  } catch (error) {
    console.error(`Error checking calendar connection for ${userName}:`, error)
  }
  return `${userName}: No calendar connected`
})).then((results) => results.join('\n\n'))}

Message To Reply To:
From: ${userMap.get(message.userId) || 'Unknown User'} (Timezone: ${userTimezones.get(message.userId) ? getShortTimezoneFromIANA(userTimezones.get(message.userId)!) : 'Unknown'})
Text: "${replaceUserMentions(message.text, userMap)}"
Channel: ${channelDescription}${
  message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string'
    ? `\nThread: [${formatTimestampWithTimezone(tsToDate(message.raw.thread_ts), callingUserTimezone)}]`
    : ''
}
Timestamp: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone)}

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.${prevToolResults ? prevToolResults.userPromptSuffix : ''}`

  console.log(userPrompt)

  // Define the tools - only one can be used at a time
  const availableTools = {
    findFreeSlots: tool({
      description: 'Find common free time slots for all users in the topic between specified start time and end time. Returns mathematically accurate free slots. Pass the exact user names from the User Directory.',
      parameters: z.object({
        userNames: z.array(z.string()).describe('Array of user names (exact names from User Directory) to find free slots for'),
        startTime: z.string().describe('ISO timestamp for the start of the time range to search for free slots'),
        endTime: z.string().describe('ISO timestamp for the end of the time range to search for free slots'),
      }),
      execute: async ({ userNames, startTime, endTime }) => {
        console.log('Tool called: findFreeSlots for users:', userNames, 'from', startTime, 'to', endTime)

        // Map names to user IDs for calendar lookup
        const nameToIdMap = new Map<string, string>()
        userMap.forEach((name, id) => {
          nameToIdMap.set(name, id)
        })

        // Build profiles for the time intersection tool
        const profiles: UserProfile[] = await Promise.all(
          userNames.map(async (userName) => {
            const userId = nameToIdMap.get(userName)
            if (!userId) {
              console.warn(`Could not find user ID for name: ${userName}`)
              // Return user as fully available if ID not found
              return {
                name: userName,
                calendar: [],
              }
            }

            const calendar = await getUserCalendarStructured(userId, new Date(startTime), new Date(endTime))

            if (calendar && calendar.length > 0) {
              return {
                name: userName,
                calendar: convertCalendarEventsToUserProfile(calendar),
              }
            } else {
              // User has no calendar data, treat as fully available
              return {
                name: userName,
                calendar: [],
              }
            }
          }),
        )

        // Use the time intersection tool to find common free slots
        const freeSlots = findCommonFreeTime(profiles, new Date(startTime), new Date(endTime))
        console.log('Found free slots:', freeSlots)

        return {
          freeSlots: freeSlots,
          message: freeSlots.length > 0
            ? `Found ${freeSlots.length} available time slots`
            : 'No common free slots found for all participants',
        }
      },
    }),
    updateUserNames: tool({
      description: 'Update the list of users involved in the scheduling topic. Provide the COMPLETE list of user names who should be involved going forward (this replaces the existing list).',
      parameters: z.object({
        userNames: z.array(z.string()).describe('Complete list of user names who should be involved (use exact names from User Directory)'),
      }),
      execute: async ({ userNames }) => {
        console.log('Tool called: updateUserNames with names:', userNames)

        // Map names to user IDs
        const updatedUserIds: string[] = []
        const unmappedNames: string[] = []

        for (const name of userNames) {
          let foundId: string | undefined
          for (const [id, mappedName] of userMap.entries()) {
            if (mappedName === name) {
              foundId = id
              break
            }
          }

          if (foundId) {
            updatedUserIds.push(foundId)
          } else {
            unmappedNames.push(name)
          }
        }

        // Update the topic in the database with the new user IDs
        const [updatedTopic] = await db
          .update(topicTable)
          .set({
            userIds: updatedUserIds,
            updatedAt: new Date(),
          })
          .where(eq(topicTable.id, topic.id))
          .returning()

        // Map IDs back to names for the response
        const updatedUserNames = updatedUserIds.map((id) => userMap.get(id) || id)

        return {
          updatedTopic,
          updatedUserNames,
          message: unmappedNames.length > 0
            ? `Updated user list to: ${updatedUserNames.join(', ')}. Warning: Could not find users: ${unmappedNames.join(', ')}`
            : `Successfully updated user list to: ${updatedUserNames.join(', ')}`,
        }
      },
    }),
    updateUserCalendar: tool({
      description: 'Update a user\'s calendar with manual availability overrides. These will be merged with their existing calendar, overwriting any overlapping time periods.',
      parameters: z.object({
        userName: z.string().describe('User name (exact name from User Directory) whose calendar to update'),
        events: z.array(z.object({
          start: z.string().describe('ISO timestamp for the start of the event'),
          end: z.string().describe('ISO timestamp for the end of the event'),
          summary: z.string().describe('Description of the event (e.g., "Available", "Busy", "Meeting")'),
          free: z.boolean().optional().describe('Whether the user is free during this time (default: false, meaning busy)'),
        })).describe('List of calendar events to add/update for the user'),
      }),
      execute: async ({ userName, events }) => {
        console.log('Tool called: updateUserCalendar for user:', userName, 'with events:', events)

        // Map name to user ID
        let userId: string | undefined
        for (const [id, mappedName] of userMap.entries()) {
          if (mappedName === userName) {
            userId = id
            break
          }
        }

        if (!userId) {
          console.warn(`Could not find user ID for name: ${userName}`)
          return {
            success: false,
            message: `User "${userName}" not found in the User Directory`,
          }
        }

        // Get current user context
        const currentContext = await getUserContext(userId)
        const existingOverrides = currentContext.calendarManualOverrides || []

        // Convert events to CalendarEvent type
        const newOverrides: CalendarEvent[] = events.map((event) => ({
          start: event.start,
          end: event.end,
          summary: event.summary,
          free: event.free,
        }))

        // Merge existing overrides with new ones (new ones take precedence)
        const mergedOverrides = mergeCalendarWithOverrides(existingOverrides, newOverrides)

        // Update user context with merged overrides
        await updateUserContext(userId, {
          calendarManualOverrides: mergedOverrides,
        })

        console.log(`Updated calendar overrides for user ${userName} (${userId}): ${mergedOverrides.length} total overrides`)

        return {
          success: true,
          userName,
          updatedEvents: newOverrides.length,
          totalOverrides: mergedOverrides.length,
          message: `Updated ${userName}'s calendar with ${newOverrides.length} event(s)`,
        }
      },
    }),
  }

  try {
    console.log('=== CALLING LLM IN scheduleNextStep ===')
    console.log('User prompt length:', userPrompt.length)
    console.log('Topic user IDs:', topic.userIds)
    console.log('Message user ID:', message.userId)

    // Only pass tools that haven't been called yet
    const toolsToPass = prevToolResults
      ? Object.fromEntries(
          Object.entries(availableTools).filter(([toolName]) =>
            !prevToolResults.toolsCalled.includes(toolName),
          ),
        )
      : availableTools

    const res = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      maxTokens: 1024,
      temperature: 0.7,
      system: systemPrompt,
      tools: toolsToPass,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    })

    // Parse the JSON response
    console.log('LLM response text:', res.text)
    console.log('Tool calls:', res.toolCalls)
    console.log('Tool results:', res.toolResults)

    // Track if tools were used
    const toolUsed = res.toolCalls && res.toolCalls.length > 0

    // If tools were called, we need to recursively call scheduleNextStep with the tool results
    if (res.toolCalls && res.toolCalls.length > 0) {
      const toolCall = res.toolCalls[0]
      const toolResult = res.toolResults?.[0]

      // Handle different tool results
      let userPromptSuffix = ''
      let updatedTopic: Topic | undefined

      // Type guards for tool results
      interface ToolCallWithName {
        toolName: string
      }

      interface FreeSlotsResult {
        result: {
          freeSlots: Array<{ start: Date, end: Date }>
          message: string
        }
      }

      interface UpdateUserNamesResult {
        result: {
          updatedTopic: Topic
          updatedUserNames: string[]
          message: string
        }
      }

      if (toolCall && typeof toolCall === 'object' && 'toolName' in toolCall) {
        const toolName = (toolCall as ToolCallWithName).toolName

        if (toolName === 'findFreeSlots' && toolResult) {
          const result = toolResult as FreeSlotsResult
          const freeSlots = result.result?.freeSlots || []
          userPromptSuffix = `\n\nThe findFreeSlots tool was called and returned these available time slots for all participants:
${freeSlots.map((slot) => {
  // Format for calling user's timezone
  const startFormatted = formatTimestampWithTimezone(slot.start, callingUserTimezone)
  const startDate = new Date(slot.start)
  const endDate = new Date(slot.end)
  const isSameDay = startDate.toDateString() === endDate.toDateString()

  // Calculate duration
  const durationMs = endDate.getTime() - startDate.getTime()
  const hours = Math.floor(durationMs / (1000 * 60 * 60))
  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60))
  let durationStr = ''
  if (hours > 0 && minutes > 0) {
    durationStr = `${hours}h ${minutes}m`
  } else if (hours > 0) {
    durationStr = `${hours}h`
  } else {
    durationStr = `${minutes}m`
  }

  const endTime = isSameDay
    ? endDate.toLocaleString('en-US', {
        timeZone: callingUserTimezone || 'UTC',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : formatTimestampWithTimezone(slot.end, callingUserTimezone)

  return `- [${durationStr}] ${startFormatted} to ${endTime}`
}).join('\n')}

Remember to always include timezone abbreviations when suggesting these times to users, and convert to each user's timezone when sending individual messages.

Based on these available times, determine the next step in the scheduling workflow.`
        } else if (toolName === 'updateUserNames' && toolResult) {
          const result = toolResult as UpdateUserNamesResult
          updatedTopic = result.result?.updatedTopic
          const updatedUserNames = result.result?.updatedUserNames || []

          userPromptSuffix = `\n\nThe updateUserNames tool was called and updated the user list.
Updated users: ${updatedUserNames.join(', ')}

Based on this update, determine the next step in the scheduling workflow.`
        } else if (toolName === 'updateUserCalendar' && toolResult) {
          interface UpdateUserCalendarResult {
            result: {
              success: boolean
              userName?: string
              updatedEvents?: number
              totalOverrides?: number
              message: string
            }
          }
          const result = toolResult as UpdateUserCalendarResult
          const success = result.result?.success
          const userName = result.result?.userName || 'Unknown'
          const updatedEvents = result.result?.updatedEvents || 0
          userPromptSuffix = success
            ? `\n\nThe updateUserCalendar tool was called and successfully updated ${userName}'s calendar with ${updatedEvents} event(s).
The user's availability has been recorded and will be considered when finding free slots.

Based on this update, determine the next step in the scheduling workflow.`
            : `\n\nThe updateUserCalendar tool was called but failed: ${result.result?.message}

Please try again or proceed without updating the calendar.`
        }

        // Recursively call scheduleNextStep with the tool results
        // Use the updated topic if updateUserNames was called
        const topicToUse = toolName === 'updateUserNames' && updatedTopic ? updatedTopic : topic

        // Accumulate tools called and append to existing prompt suffix
        const allToolsCalled = [...(prevToolResults?.toolsCalled || []), toolName]
        const fullPromptSuffix = (prevToolResults?.userPromptSuffix || '') + userPromptSuffix

        const result = await scheduleNextStep(
          message,
          topicToUse,
          previousMessages,
          userMap,
          botUserId,
          {
            toolsCalled: allToolsCalled,
            userPromptSuffix: fullPromptSuffix,
          },
        )

        // Preserve tool usage tracking from original call
        return { ...result, toolUsed: result.toolUsed || toolUsed }
      }
    }

    // If there are no tool calls, parse the response
    const nextStep = parseResponseJSON(res.text) as {
      replyMessage: string
      updateSummary?: string
      markTopicInactive?: boolean
      messagesToUsers?: {
        userIds: string[]
        userNames?: string[]
        text: string
        includeCalendarButtons?: boolean
      }[]
      groupMessage?: string
      reasoning: string
    }

    return { ...nextStep, toolUsed }
  } catch (error) {
    console.error('=== ERROR IN scheduleNextStep ===')
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
    console.error('Error message:', error instanceof Error ? error.message : String(error))
    console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace')
    console.error('Full error object:', JSON.stringify(error, null, 2))
    console.error('=================================')

    // Return a safe default response
    return {
      replyMessage: 'I encountered an error processing the scheduling request.',
      reasoning: `Error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
      toolUsed: false,
    }
  }
}

/**
 * Generate realistic fake calendar events for a user
 * Used for testing and development when real calendar data isn't available
 */
export async function generateFakeCalendarEvents(
  timezone: string,
  startTime: Date,
  endTime: Date,
): Promise<Array<{ start: string, end: string, summary: string }>> {
  // Random persona attributes for more diverse schedules
  const adjectives = [
    'experienced', 'innovative', 'strategic', 'creative', 'meticulous',
    'quirky', 'maverick', 'pragmatic', 'visionary', 'fearless',
  ]

  const professions = [
    'software engineer', 'product manager', 'chef', 'electrician', 'nurse',
    'teacher', 'artist', 'farmer', 'pilot', 'barista',
    'firefighter', 'veterinarian', 'podcast host', 'mechanic', 'therapist',
    'musician', 'real estate agent', 'park ranger', 'tattoo artist', 'marine biologist',
    'truck driver', 'yoga instructor', 'locksmith', 'mortician', 'puppeteer',
    'wind turbine technician', 'cheese maker', 'escape room designer', 'snake milker',
  ]

  const industries = [
    'technology', 'healthcare', 'construction', 'agriculture', 'education',
    'restaurants', 'renewable energy', 'entertainment', 'transportation', 'emergency services',
    'manufacturing', 'non-profits', 'fitness & wellness', 'funeral services', 'space exploration',
    'gaming', 'pet care', 'theme parks', 'paranormal investigation', 'artisanal crafts',
  ]

  // Randomly select one from each category
  const randomAdjective = adjectives[Math.floor(Math.random() * adjectives.length)]
  const randomProfession = professions[Math.floor(Math.random() * professions.length)]
  const randomIndustry = industries[Math.floor(Math.random() * industries.length)]

  const systemPrompt = `Generate calendar events for a person's work schedule in JSON format.

Guidelines:
- Generate events mostly on weekdays, during work hours in the user's timezone (work hours depend on role / industry)
- Don't over-schedule - aim for maximum 60-70% calendar density during work hours, and much less calendar density on weekends, or depending on role / industry

Return ONLY a JSON array of objects with this structure:
[
  {
    "start": "2024-01-15T09:00:00-08:00",
    "end": "2024-01-15T09:30:00-08:00",
    "summary": "Team Standup"
  }
]

Make sure all timestamps are in ISO 8601 format with the correct timezone offset.`

  const userPrompt = `Generate realistic calendar events in timezone ${timezone}.

Date range: ${startTime.toISOString()} to ${endTime.toISOString()}

The person is an ${randomAdjective} ${randomProfession} working in ${randomIndustry}. They should have a professional schedule with a variety of meetings and work blocks relevant to their role and industry.`

  try {
    const { text } = await generateText({
      model: openrouter('anthropic/claude-sonnet-4'),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 1,
    })

    // Parse the JSON response
    const events = parseResponseJSON(text) as Array<{ start: string, end: string, summary: string }>

    // Validate the structure
    if (!Array.isArray(events)) {
      throw new Error('Response is not an array')
    }

    // Validate each event has required fields
    return events.filter((event) =>
      event.start &&
      event.end &&
      event.summary &&
      typeof event.start === 'string' &&
      typeof event.end === 'string' &&
      typeof event.summary === 'string',
    )
  } catch (error) {
    console.error('Error generating fake calendar events:', error)
    return []
  }
}
