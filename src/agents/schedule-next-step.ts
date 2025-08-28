import { eq } from 'drizzle-orm'
import { z } from 'zod'

import type { RunContext } from './agent-sdk'
import { Agent, Runner, tool, ModelBehaviorError } from './agent-sdk'
import db from '../db/engine'
import type { Topic, SlackMessage, SlackUser } from '../db/schema/main'
import { topicTable } from '../db/schema/main'
import {
  tsToDate,
  organizeMessagesByChannelAndThread,
  replaceUserMentions,
  getChannelDescription,
  formatTimestampWithTimezone,
} from '../utils'
import { getShortTimezoneFromIANA, mergeCalendarWithOverrides } from '@shared/utils'
import { CalendarEvent } from '@shared/api-types'
import { generateGoogleAuthUrl, getUserCalendarStructured, isCalendarConnected, updateTopicUserContext } from '../calendar-service'
import type { UserProfile } from '../tools/time_intersection'
import { findCommonFreeTime, convertCalendarEventsToUserProfile } from '../tools/time_intersection'

interface ScheduleNextStepContext {
  topic: Topic,
  userMap: Map<string, SlackUser>,
  callingUserTimezone: string,
}

const findFreeSlots = tool({
  name: 'findFreeSlots',
  description: 'Find common free time slots for all users in the topic between specified start time and end time. Returns mathematically accurate free slots. Pass the exact user names from the User Directory.',
  parameters: z.object({
    userNames: z.array(z.string()).describe('Array of user names (exact names from User Directory) to find free slots for'),
    startTime: z.string().describe('ISO timestamp for the start of the time range to search for free slots'),
    endTime: z.string().describe('ISO timestamp for the end of the time range to search for free slots'),
  }),
  execute: async ({ userNames, startTime, endTime }, runContext?: RunContext<ScheduleNextStepContext>) => {
    console.log('Tool called: findFreeSlots for users:', userNames, 'from', startTime, 'to', endTime)

    if (!runContext) throw new Error('runContext not provided')
    const { userMap, callingUserTimezone, topic } = runContext.context

    // Map names to user IDs for calendar lookup
    const nameToIdMap = new Map<string, string>()
    userMap.forEach((user, id) => {
      if (user.realName) {
        nameToIdMap.set(user.realName, id)
      }
    })

    // Build profiles for the time intersection tool
    const profiles: (UserProfile | null)[] = await Promise.all(
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

        const calendar = await getUserCalendarStructured(userId, topic, new Date(startTime), new Date(endTime))

        // If the user has no calendar info, return null
        if (calendar === null) {
          return null
        }

        return {
          name: userName,
          calendar: convertCalendarEventsToUserProfile(calendar),
        }
      }),
    )

    const profilesWithCal = profiles.filter((p) => p !== null)
    const usersWithCal = profilesWithCal.map((p) => p.name)
    const usersNoCal = userNames.filter((name) => !usersWithCal.includes(name))
    const usersNoCalStr = usersNoCal.length > 0 ? `These users had no calendar info: ${usersNoCal.join(', ')}\n` : ''

    // Use the time intersection tool to find common free slots
    const freeSlots = findCommonFreeTime(profilesWithCal, new Date(startTime), new Date(endTime))
    const freeSlotsStr = freeSlots.map((slot) => {
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
    }).join('\n')

    const res = `${usersNoCalStr}These time slots are available for users ${usersWithCal.join(', ')}:\n${freeSlotsStr}`
    console.log(res)
    return res
  },
})

const updateUserNames = tool({
  name: 'updateUserNames',
  description: 'Update the list of users involved in the scheduling topic. Provide the COMPLETE list of user names who should be involved going forward (this replaces the existing list).',
  parameters: z.strictObject({
    userNames: z.array(z.string()).describe('Complete list of user names who should be involved (use exact names from User Directory)'),
  }),
  execute: async ({ userNames }, runContext?: RunContext<ScheduleNextStepContext>) => {
    console.log('Tool called: updateUserNames with names:', userNames)

    if (!runContext) throw new Error('runContext not provided')
    const { topic, userMap } = runContext.context

    // Map names to user IDs
    const updatedUserIds: string[] = []

    for (const name of userNames) {
      let foundId: string | undefined
      for (const [id, user] of userMap.entries()) {
        if (user.realName === name) {
          foundId = id
          break
        }
      }

      if (foundId) {
        updatedUserIds.push(foundId)
      } else {
        throw new Error(`Could not find user ID for name: ${name}`)
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

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    // Map IDs back to names for the response
    const updatedUserNames = updatedUserIds.map((id) => userMap.get(id)?.realName || id)
    return `Updated user list to: ${updatedUserNames.join(', ')}`
  },
})

const updateUserCalendar = tool({
  name: 'updateUserCalendar',
  description: 'Update a user\'s calendar with manual availability overrides. These will be merged with their existing calendar, overwriting any overlapping time periods.',
  parameters: z.strictObject({
    userName: z.string().describe('User name (exact name from User Directory) whose calendar to update'),
    events: z.array(CalendarEvent).describe('List of calendar events to add/update for the user'),
  }),
  execute: async ({ userName, events }, runContext?: RunContext<ScheduleNextStepContext>) => {
    console.log('Tool called: updateUserCalendar for user:', userName, 'with events:', events)

    if (!runContext) throw new Error('runContext not provided')
    const { userMap, topic } = runContext.context

    // Map name to user ID
    let userId: string | undefined
    for (const [id, user] of userMap.entries()) {
      if (user.realName === userName) {
        userId = id
        break
      }
    }
    if (!userId) {
      throw new Error(`Could not find user ID for name: ${userName}`)
    }

    // Get current topic-specific user context
    const currentTopicContext = topic.perUserContext[userId]
    const existingOverrides = currentTopicContext?.calendarManualOverrides || []

    // Convert events to CalendarEvent type
    const newOverrides: CalendarEvent[] = events.map((event) => ({
      start: event.start,
      end: event.end,
      summary: event.summary,
      free: event.free,
    }))

    // Merge existing overrides with new ones (new ones take precedence)
    const mergedOverrides = mergeCalendarWithOverrides(existingOverrides, newOverrides)

    // Update topic-specific user context with merged overrides and update runContext
    const updatedTopic = await updateTopicUserContext(topic.id, userId, {
      calendarManualOverrides: mergedOverrides,
    })

    // Update the topic in runContext with the updated version
    runContext.context.topic = updatedTopic

    console.log(`Updated calendar overrides for user ${userName} (${userId}) in topic ${topic.id}: ${mergedOverrides.length} total overrides`)

    return `Updated ${userName}'s calendar with ${newOverrides.length} event(s). The user's availability has been recorded and will be considered when finding free slots.`
  },
})

const updateSummary = tool({
  name: 'updateSummary',
  description: 'Update the topic summary when new information clarifies or changes the meeting details.',
  parameters: z.strictObject({
    summary: z.string().describe('The updated topic summary describing what needs to be scheduled'),
  }),
  execute: async ({ summary }, runContext?: RunContext<ScheduleNextStepContext>) => {
    console.log('Tool called: updateSummary with summary:', summary)

    if (!runContext) throw new Error('runContext not provided')
    const { topic } = runContext.context

    // Update the topic in the database with the new summary
    const [updatedTopic] = await db
      .update(topicTable)
      .set({
        summary,
        updatedAt: new Date(),
      })
      .where(eq(topicTable.id, topic.id))
      .returning()

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    return `Updated topic summary to: ${summary}`
  },
})

const ScheduleNextStepRes = z.strictObject({
  replyMessage: z.string().optional().nullable(),
  markTopicInactive: z.boolean().optional().nullable(),
  messagesToUsers: z.array(z.strictObject({
    userNames: z.array(z.string()),
    text: z.string(),
  })).optional().nullable(),
  groupMessage: z.string().optional().nullable(),
  reasoning: z.string(),
})
type ScheduleNextStepRes = z.infer<typeof ScheduleNextStepRes>

async function scheduleNextStepInstructions(runContext: RunContext<ScheduleNextStepContext>) {
  const mainPrompt = `You are a scheduling assistant that helps coordinate meetings and events. Your job is to determine the next step in the scheduling process and generate appropriate responses.

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
Based on the current state, determine what tools to call (if any) and generate the appropriate message(s) to users, if they are necessary to move the scheduling task along

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
  - CRITICAL: If a user's calendar is connected or has been created from conversation (see Calendar Information: below), you do NOT need to ask them for availability. Instead, use the findFreeSlots tool to find the intersection of their availability with other users
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
- CRITICAL: When you have calendar data for all users (i.e. under "Calendar Information:" it says either calendar is connected or calendar created from conversation), ALWAYS use the findFreeSlots tool to find accurate available times before proposing any meeting slots
- NEVER propose times without first calling findFreeSlots - this ensures you only suggest times that actually work for everyone
- After calling findFreeSlots, propose 2-3 specific time slots from the results in your very next message
- Skip pleasantries and acknowledgments - get straight to business
- Respect privacy - don't share individual constraints publicly
- Only move to finalize when you've found a time that works for all participants
- ALWAYS include timezone abbreviations when mentioning times (e.g., "2pm (PST)")
- When users are in different timezones, show times in each user's local timezone
- Use common sense for activity timing (coffee = morning/afternoon, dinner = evening)
- Use the updateSummary tool whenever new information clarifies or changes the meeting details
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
You have access to FOUR tools, but you can ONLY USE ONE per response:

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

4. **updateSummary**: Updates the topic summary
   - USE THIS whenever new information clarifies or changes the meeting details
   - Pass the updated summary describing what needs to be scheduled
   - Helps maintain context for the scheduling process

## Response Format
When calling a tool:
- Do NOT return any JSON or text content
- Simply call the tool and let it execute
- The tool response will be handled automatically

When NOT calling a tool, return ONLY a JSON object with these fields:
{
  "replyMessage": "Message text",  // Optional: Include to reply to the sent message
  "markTopicInactive": true,      // Optional: Include to mark topic as inactive
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
  "reasoning": "Brief explanation of the decision"  // REQUIRED: Always include reasoning
}

IMPORTANT:
- When calling tools: Output NOTHING - just call the tool
- When not calling tools: Return ONLY the JSON object above
- Do not include any text before or after the JSON`

  const { topic, userMap, callingUserTimezone } = runContext.context

  const userMapAndTopicInfo = `
${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries())
  .filter(([_userId, user]) => !user.isBot && user.realName)
  .sort((a, b) => (a[1].realName!).localeCompare(b[1].realName!))
  .map(([_userId, user]) => user.realName)
  .join(', ')}

` : ''}Current Topic:
Summary: ${topic.summary}
Users involved (with timezones and calendar status):
${await Promise.all(topic.userIds.map(async (userId) => {
  const user = userMap.get(userId)
  const userName = user?.realName || 'Unknown User'
  const tz = user?.tz
  const userTzStr = tz ? `${userName} (${getShortTimezoneFromIANA(tz)})` : userName

  // Check for manual overrides for this user in the current topic
  const topicContext = topic.perUserContext[userId]
  const hasManualOverrides = topicContext?.calendarManualOverrides && topicContext.calendarManualOverrides.length > 0

  try {
    const isConnected = await isCalendarConnected(userId)
    if (isConnected) {
      return `  ${userTzStr}: Calendar is connected${hasManualOverrides ? ', and refined from conversation' : ''}`
    }
  } catch (error) {
    console.error(`Error checking calendar connection for ${userName}:`, error)
  }

  if (hasManualOverrides) {
    return `  ${userTzStr}: Calendar created from conversation`
  }
  return `  ${userTzStr}: No calendar connected`
})).then((results) => results.join('\n'))}
Created: ${formatTimestampWithTimezone(topic.createdAt, callingUserTimezone)}
Last updated: ${formatTimestampWithTimezone(topic.updatedAt, callingUserTimezone)}`

  console.log(`User Map and Topic Info from system prompt: ${userMapAndTopicInfo}`)

  return mainPrompt + userMapAndTopicInfo
}

const scheduleNextStepAgent = new Agent<ScheduleNextStepContext, typeof ScheduleNextStepRes>({
  name: 'scheduleNextStepAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0.7,
    parallelToolCalls: false, // Only allow one tool call at a time
  },
  tools: [findFreeSlots, updateUserNames, updateUserCalendar, updateSummary],
  outputType: ScheduleNextStepRes,
  instructions: scheduleNextStepInstructions,
})


export async function scheduleNextStep(
  message: SlackMessage,
  topic: Topic,
  previousMessages: SlackMessage[],
  userMap: Map<string, SlackUser>,
): Promise<ScheduleNextStepRes> {
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
    }
  }

  // Get timezone information for the calling user
  const callingUser = userMap.get(message.userId)
  const callingUserTimezone = callingUser?.tz || 'UTC'

  // Get channel information for descriptive display
  const channelDescription = await getChannelDescription(message.channelId, userMap)

  const userPrompt = `Your name in conversations: ${userMap.get(topic.botUserId)?.realName || 'Assistant'}

Previous Messages in this Topic:
${await organizeMessagesByChannelAndThread(previousMessages, callingUserTimezone)}

Message To Reply To:
From: ${userMap.get(message.userId)?.realName || 'Unknown User'} (Timezone: ${callingUser?.tz ? getShortTimezoneFromIANA(callingUserTimezone) : 'Unknown'})
Text: "${replaceUserMentions(message.text, userMap)}"
Channel: ${channelDescription}${
  message.raw && typeof message.raw === 'object' && 'thread_ts' in message.raw && typeof message.raw.thread_ts === 'string'
    ? `\nThread: [${formatTimestampWithTimezone(tsToDate(message.raw.thread_ts), callingUserTimezone)}]`
    : ''
}
Timestamp: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone)}

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.`

  console.log(`User prompt: ${userPrompt}`)

  try {
    console.log('=== CALLING LLM IN scheduleNextStep ===')
    console.log('User prompt length:', userPrompt.length)
    console.log('Topic user IDs:', topic.userIds)
    console.log('Message user ID:', message.userId)

    const runner = new Runner({ groupId: `topic-${topic.id}` })
    const result = await runner.run(
      scheduleNextStepAgent,
      userPrompt,
      { context: { topic, userMap, callingUserTimezone } },
    )
    if (!result.finalOutput) {
      throw new Error('No finalOutput generated')
    }
    return result.finalOutput
  } catch (error) {
    console.error('=== ERROR IN scheduleNextStep ===')
    console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
    console.error('Error message:', error instanceof Error ? error.message : String(error))
    console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace')
    console.error('Full error object:', JSON.stringify(error, null, 2))
    if (error instanceof ModelBehaviorError) {
      console.error('Run state', error.state ? error.state.toJSON() : 'No run state')
    }
    console.error('=================================')

    // Return a safe default response
    return {
      replyMessage: 'I encountered an error processing the scheduling request.',
      reasoning: `Error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
