import { z } from 'zod'

import type { RunContext } from './agent-sdk'
import { tool, PROMPT_CACHE_BOUNDARY } from './agent-sdk'
import { formatTimestampWithTimezone } from '../utils'
import { getShortTimezoneFromIANA, mergeCalendarWithOverrides } from '@shared/utils'
import { CalendarEvent } from '@shared/api-types'
import type { ConversationContext } from './conversation-utils'
import { updateSummary, updateUserNames, makeConversationAgent } from './conversation-utils'
import { getUserCalendarStructured, listBotScheduledEvents, updateTopicUserContext } from '../calendar-service'
import { isGoogleCalendarConnected } from '../integrations/google'
import type { UserProfile } from '../tools/time_intersection'
import { findCommonFreeTime, convertCalendarEventsToUserProfile } from '../tools/time_intersection'

const findFreeSlots = tool({
  name: 'findFreeSlots',
  description: 'Find common free time slots for all users in the topic between specified start time and end time. Returns mathematically accurate free slots. Pass the exact user names from the User Directory. CRITICAL: Always use the correct year based on the current date and the timeframe being requested (e.g., if it\'s October 2025 and the user asks for "next Tuesday", that\'s in 2025, not 2024).',
  parameters: z.object({
    userNames: z.array(z.string()).describe('Array of user names (exact names from User Directory) to find free slots for'),
    startTime: z.string().describe('ISO timestamp for the start of the time range to search for free slots. CRITICAL: Use the correct year based on the current date/time provided in the context and the user\'s request (e.g., if today is Oct 14, 2025 and user asks for "next Tuesday", use 2025 not 2024).'),
    endTime: z.string().describe('ISO timestamp for the end of the time range to search for free slots. CRITICAL: Use the correct year based on the current date/time provided in the context and the user\'s request (e.g., if today is Oct 14, 2025 and user asks for "next Tuesday", use 2025 not 2024).'),
  }),
  execute: async ({ userNames, startTime, endTime }, runContext?: RunContext<ConversationContext>) => {
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

const updateUserCalendar = tool({
  name: 'updateUserCalendar',
  description: 'Update a user\'s calendar with manual availability overrides based on information in the current message being replied to. ONLY call this based on availability info in the current message, NOT from previous messages in the topic. These will be merged with their existing calendar, overwriting any overlapping time periods.',
  parameters: z.strictObject({
    userName: z.string().describe('User name (exact name from User Directory) whose calendar to update'),
    events: z.array(CalendarEvent).describe('List of calendar events to add/update for the user'),
  }),
  execute: async ({ userName, events }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: updateUserCalendar for user:', userName, 'with events:', events)

    if (!runContext) throw new Error('runContext not provided')
    const { userMap, topic, message } = runContext.context

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
    const currentTopicContext = topic.state.perUserContext[userId]
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
    const updatedTopic = await updateTopicUserContext(
      topic.id,
      userId,
      { calendarManualOverrides: mergedOverrides },
      message.id,
    )

    // Update the topic in runContext with the updated version
    runContext.context.topic = updatedTopic

    console.log(`Updated calendar overrides for user ${userName} (${userId}) in topic ${topic.id}: ${mergedOverrides.length} total overrides`)

    return `Updated ${userName}'s calendar with ${newOverrides.length} event(s). The user's availability has been recorded and will be considered when finding free slots.`
  },
})

async function schedulingInstructions(runContext: RunContext<ConversationContext>) {
  const mainPrompt = `You are a scheduling assistant that helps coordinate meetings and events. Your job is to determine the next step in the scheduling process and generate appropriate responses.

## Important Timezone Instructions
- ALWAYS include timezone abbreviations in parentheses next to ALL times you mention (e.g., "2pm (PST)" or "3:30pm (EST)")
- When responding to a user, ALWAYS use their timezone for suggested times
- Be explicit about timezone differences when they exist between participants
- When proposing times to multiple users with different timezones, show the time in each user's timezone

## Responsiveness
- Always provide a helpful reply whenever the user sends a direct message or addresses you explicitly. Never leave a user query unanswered.

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
  - Only use when you have identified a time that works for all participants and still need explicit confirmation from them
  - Return replyMessage with confirmation
  - Keep confirmations concise and avoid implying that a calendar invite has already been sent

5. Scheduling is done
  - If all users reply that this time works for them, or they agree to cancel the meeting, set markTopicInactive: true to indicate this topic should be marked inactive
  - When the meeting is cancelled, also set cancelEvent: true so the existing calendar invite is deleted (and normally skip finalizedEvent)
  - When finalizing a specific meeting time, ALSO include a finalizedEvent object with exact ISO start and end fields and a summary. The system will use this to send a calendar invite from the meeting leader.
  - Set finalizedEvent.summary to 'Meeting with <list of all confirmed human participants>' using the exact full names (include the scheduler/initiator even if they requested the meeting).
  - Pair the finalizedEvent with a short groupMessage confirming the plan (e.g., "Locked in Tue 1pm (EST). Invite is on the way."), but do not include calendar links or restate the full invite details yourself.

- Miscellaneous actions needed
  - Sometimes you need to ask for clarification, provide updates, or handle edge cases
  - Return replyMessage with the appropriate response
  - Optionally return messagesToUsers for private 1-1 clarifications (sent as DMs)
  - Optionally return groupMessage for updates to all users in shared channel
  - Can use updateUserNames tool if users need to be added/removed (use exact names from User Directory)
  - If someone asks whether their calendar is connected, consult the “Calendar Information” section and answer directly (✅ Connected / ❌ Not connected), optionally reminding them how to connect if needed.

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
- When you revise the topic summary or finalizedEvent summary, list every confirmed attendee explicitly (include the scheduler/initiator so the meeting title reads like 'Meeting with Alice, Bob, and Taylor').
- messagesToUsers always sends private 1-1 DMs; groupMessage always sends to a shared channel with all topic users
- CRITICAL: When you include a finalizedEvent, include a concise groupMessage confirming the decision. Let the platform announce the calendar update, and avoid duplicating the invite details or sharing Meet links manually.
- ALWAYS return a well-formed JSON object that matches the required schema.
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
You have access to FOUR tools and can call multiple tools in sequence within the same turn. After a tool completes, you'll immediately get another chance to act—keep calling whichever tools you still need until you're ready to send the final JSON response. Only return JSON once all necessary tool calls for this turn are finished; never stop mid-sequence with an empty reply.

1. **findFreeSlots**: Finds mathematically accurate free time slots
   - USE THIS before proposing any meeting times when you have calendar data
   - Pass the exact user names from the User Directory (e.g., "John Smith", "Jane Doe")
   - Returns guaranteed-free slots that work for everyone
   - Never propose times without using this tool first

2. **updateUserNames**: Updates the list of users involved in the scheduling
   - USE THIS when you need to add/remove users from the topic (action: "identify_users")
   - Provide the COMPLETE list of user names (this replaces the existing list)
   - Use exact names from the User Directory

3. **updateUserCalendar**: Updates a user's calendar with manual availability overrides
   - CRITICAL: ONLY call this based on availability information in the current "Message To Reply To", NOT from previous messages in the topic
   - USE THIS when a user explicitly tells you their availability or when they're busy/free IN THE CURRENT MESSAGE
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
- Output NOTHING - just call the tool
- The tool response will be handled automatically

When ready to provide your final response, call the \`output\` tool with these fields:
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
  // CRITICAL: If you confirm an exact meeting time in groupMessage, ALSO include a matching finalizedEvent in the same response
  "finalizedEvent": {               // OPTIONAL: Include ONLY when the exact final time is agreed
    "start": "2025-03-12T18:00:00Z", // ISO string
    "end": "2025-03-12T18:30:00Z",   // ISO string
    "summary": "Meeting with Alice, Bob, and Chris" // Must list every confirmed participant, including the scheduler
  },
  "cancelEvent": true,              // OPTIONAL: Set true when the meeting is cancelled and the calendar invite should be deleted
}

CRITICAL: Output NOTHING when calling the \`output\` tool - just call the tool with the parameters
- Do not include any text or explanation before or after calling the \`output\` tool

IMPORTANT:
- When calling ANY tool (including the \`output\` tool): Output NOTHING - just call the tool
- When ready to provide your final response: Call the \`output\` tool with the fields above
- CRITICAL: Do NOT output any text, explanation, or commentary when calling the \`output\` tool
- The \`output\` tool accepts the same structure as before - just call it instead of returning JSON directly
- Common mistakes to avoid:
  * Outputting text or explanation when calling the \`output\` tool (output NOTHING)
  * Forgetting to call the \`output\` tool when ready to respond
  * Mixing tool calls with text output in the same response
- Example waiting response (call the output tool):
  output({
    "replyMessage": "",
    "markTopicInactive": false,
    "messagesToUsers": null,
    "groupMessage": null,
    "finalizedEvent": null,
    "cancelEvent": null,
  })

## Rescheduling Behavior (Important)
- If there is exactly ONE scheduled meeting in this topic (see the numbered list under "Current Scheduled Events") and the user says "move it" / "reschedule it" or refers to "the meeting", assume they mean that single meeting. Do not ask which meeting; finalize the new time directly.
- If there are MULTIPLE scheduled meetings and the request is ambiguous, ask a brief clarification referring to the numbered entries (e.g., "[1]" or "[2]") and showing the day/time. If the message clearly references a specific day/time, pick that one directly.
- To reschedule, just include a new finalizedEvent with the requested start/end; the system will update the existing invite.
- When participants agree to cancel the meeting entirely, set cancelEvent: true (and normally omit finalizedEvent) so the existing invite is removed, and clearly notify everyone of the cancellation.`

  const { topic, userMap, callingUserTimezone } = runContext.context

  let scheduledSection = ''
  try {
    const scheduledEvents = await listBotScheduledEvents(topic.id)
    if (scheduledEvents.length > 0) {
      const scheduledDisplay = scheduledEvents
        .filter((event) => !event.free)
        .map((event, index) => {
          if (!event.start || !event.end) return null
          const start = new Date(event.start)
          const end = new Date(event.end)
          const startStr = formatTimestampWithTimezone(start, callingUserTimezone)
          const endStr = formatTimestampWithTimezone(end, callingUserTimezone)
          const title = event.summary ? ` — ${event.summary}` : ''
          const participants = event.participantEmails?.length
            ? ` (with: ${event.participantEmails.join(', ')})`
            : ''
          return `  [${index + 1}] ${startStr} to ${endStr}${title}${participants}`
        })
        .filter((line): line is string => Boolean(line))

      if (scheduledDisplay.length > 0) {
        scheduledSection = `\nCurrent Scheduled Events (via calendar):\n${scheduledDisplay.join('\n')}`
      }
    }
  } catch (error) {
    console.error('Failed to list scheduled events for topic', topic.id, error)
  }

  const userMapAndTopicInfo = `
${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries())
  .filter(([_userId, user]) => !user.isBot && user.realName)
  .sort((a, b) => (a[1].realName!).localeCompare(b[1].realName!))
  .map(([_userId, user]) => user.realName)
  .join(', ')}

` : ''}Current Topic:
Summary: ${topic.state.summary}
Users involved (with timezones and calendar status):
${await Promise.all(topic.state.userIds.map(async (userId) => {
  const user = userMap.get(userId)
  const userName = user?.realName || 'Unknown User'
  const tz = user?.tz
  const userTzStr = tz ? `${userName} (${getShortTimezoneFromIANA(tz)})` : userName

  // Check for manual overrides for this user in the current topic
  const topicContext = topic.state.perUserContext[userId]
  const hasManualOverrides = topicContext?.calendarManualOverrides && topicContext.calendarManualOverrides.length > 0

  try {
    const isConnected = await isGoogleCalendarConnected(userId)
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
Last updated: ${formatTimestampWithTimezone(topic.state.createdAt, callingUserTimezone)}${scheduledSection}`

  console.log(`User Map and Topic Info from system prompt: ${userMapAndTopicInfo}`)

  return mainPrompt + PROMPT_CACHE_BOUNDARY + userMapAndTopicInfo
}

export const schedulingAgent = makeConversationAgent({
  name: 'schedulingAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0.7,
    parallelToolCalls: false,
  },
  tools: [findFreeSlots, updateUserNames, updateUserCalendar, updateSummary],
  instructions: schedulingInstructions,
})
