import { z } from 'zod'

import type { RunContext } from './agent-sdk'
import { tool } from './agent-sdk'
import { formatTimestampWithTimezone } from '../utils'
import type { ConversationContext } from './conversation-utils'
import { ConversationAgent, ConversationRes } from './conversation-utils'
import { getUserCalendarStructured, setSuppressCalendarPrompt } from '../calendar-service'
import { isGoogleCalendarConnected } from '../integrations/google'

const checkCalendarStatus = tool({
  name: 'checkCalendarStatus',
  description: 'Check whether the requesting user currently has their Google Calendar connected.',
  parameters: z.object({}).describe('No parameters required'),
  execute: async (_input, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message } = runContext.context
    const connected = await isGoogleCalendarConnected(message.userId)
    return connected ? 'connected' : 'disconnected'
  },
})

const setCalendarPromptPreference = tool({
  name: 'setCalendarPromptPreference',
  description: 'Enable or disable future calendar connection prompts for the requesting user.',
  parameters: z.object({
    suppress: z.boolean().describe('Set to true to stop future prompts, false to allow prompts again'),
  }),
  execute: async ({ suppress }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message } = runContext.context
    await setSuppressCalendarPrompt(message.userId, suppress)
    return suppress ? 'prompts_suppressed' : 'prompts_enabled'
  },
})

const showMyAvailability = tool({
  name: 'showMyAvailability',
  description: 'Show the requesting user their own calendar availability (free/busy times) for a specified date range.',
  parameters: z.object({
    startTime: z.string().describe('ISO timestamp for the start of the time range'),
    endTime: z.string().describe('ISO timestamp for the end of the time range'),
  }),
  execute: async ({ startTime, endTime }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message, topic, callingUserTimezone } = runContext.context

    const calendar = await getUserCalendarStructured(message.userId, topic, new Date(startTime), new Date(endTime))

    if (calendar === null) {
      return 'calendar_not_connected'
    }

    if (calendar.length === 0) {
      return 'No events found - you appear to be free during this entire time range.'
    }

    // Format busy periods
    const busyPeriods = calendar
      .filter((event) => !event.free)
      .map((event) => {
        const startFormatted = formatTimestampWithTimezone(event.start, callingUserTimezone)
        const endDate = new Date(event.end)
        const startDate = new Date(event.start)
        const isSameDay = startDate.toDateString() === endDate.toDateString()

        const endTime = isSameDay
          ? endDate.toLocaleString('en-US', {
              timeZone: callingUserTimezone || 'UTC',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : formatTimestampWithTimezone(event.end, callingUserTimezone)

        return `- ${event.summary}: ${startFormatted} to ${endTime}`
      })

    if (busyPeriods.length === 0) {
      return 'You have events on your calendar, but they are all marked as free time.'
    }

    return `Your busy times:\n${busyPeriods.join('\n')}`
  },
})

const showOtherUsersAvailability = tool({
  name: 'showOtherUsersAvailability',
  description: 'Check connection status and show availability for other specified users.',
  parameters: z.object({
    userNames: z.array(z.string()).describe('Array of user names (exact names from User Directory) to check availability for'),
    startTime: z.string().describe('ISO timestamp for the start of the time range'),
    endTime: z.string().describe('ISO timestamp for the end of the time range'),
  }),
  execute: async ({ userNames, startTime, endTime }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { userMap, topic, callingUserTimezone } = runContext.context

    // Map names to user IDs
    const nameToIdMap = new Map<string, string>()
    userMap.forEach((user, id) => {
      if (user.realName) {
        nameToIdMap.set(user.realName, id)
      }
    })

    const results = await Promise.all(
      userNames.map(async (userName) => {
        const userId = nameToIdMap.get(userName)
        if (!userId) {
          return `${userName}: User not found`
        }

        const calendar = await getUserCalendarStructured(userId, topic, new Date(startTime), new Date(endTime))

        if (calendar === null) {
          return `${userName}: Calendar not connected`
        }

        if (calendar.length === 0) {
          return `${userName}: Free during this entire time range`
        }

        const busyPeriods = calendar
          .filter((event) => !event.free)
          .map((event) => {
            const startFormatted = formatTimestampWithTimezone(event.start, callingUserTimezone)
            const endDate = new Date(event.end)
            const startDate = new Date(event.start)
            const isSameDay = startDate.toDateString() === endDate.toDateString()

            const endTime = isSameDay
              ? endDate.toLocaleString('en-US', {
                  timeZone: callingUserTimezone || 'UTC',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })
              : formatTimestampWithTimezone(event.end, callingUserTimezone)

            return `  - ${event.summary}: ${startFormatted} to ${endTime}`
          })

        if (busyPeriods.length === 0) {
          return `${userName}: Has events but all marked as free time`
        }

        return `${userName}:\n${busyPeriods.join('\n')}`
      }),
    )

    return results.join('\n\n')
  },
})

export const calendarAgent = new ConversationAgent({
  name: 'calendarAgent',
  model: 'anthropic/claude-sonnet-4',
  tools: [checkCalendarStatus, setCalendarPromptPreference, showMyAvailability, showOtherUsersAvailability],
  outputType: ConversationRes,
  instructions: `You are Pivotal's calendar support assistant. You handle Google Calendar queries and connection administration.

## Core Responsibilities
- Check and report calendar connection status
- Request calendar connection buttons (via promptCalendarButtons field in JSON response)
- Show availability (free/busy times) for any user
- Manage calendar prompt preferences

## Response Format

You MUST return a JSON object matching this schema:
{
  "replyMessage": "text",           // Message to send to user
  "markTopicInactive": true,        // ALWAYS set to true for calendar-support topics
  "promptCalendarButtons": {        // OPTIONAL: Request calendar connection buttons be sent
    "userName": null,               // null = send to requesting user, or exact name from User Directory
    "contextMessage": "text"        // Context explaining who is asking (required when userName is not null)
  },
  "reasoning": "explanation"        // REQUIRED: Brief explanation of your decision
}

## When to Use Tools vs JSON Fields

**Use tools for:**
- checkCalendarStatus: Check if user has calendar connected
- showMyAvailability: Show requesting user's free/busy times
- showOtherUsersAvailability: Check other users' availability
- setCalendarPromptPreference: Enable/disable prompts

**After tool returns, use JSON fields for:**
- promptCalendarButtons: Request buttons be sent to user
- replyMessage: Text response to user

## Action Patterns

### Pattern 1: User wants to connect their own calendar
User: "connect my calendar"
→ Return JSON: {
  "promptCalendarButtons": { "userName": null, "contextMessage": null },
  "replyMessage": "Sending you the connection buttons via DM.",
  "markTopicInactive": true,
  "reasoning": "User requested connection, sending buttons to requesting user"
}

### Pattern 2: Check if connected, offer buttons if not
User: "am I connected?"
→ Call checkCalendarStatus tool (no JSON)
→ [Tool returns "disconnected"]
→ Return JSON: {
  "replyMessage": "❌ Not connected. Would you like me to send the connection buttons?",
  "markTopicInactive": true,
  "reasoning": "Checked status, user not connected, offering help"
}

[NEW TURN]
User: "yes"
→ Return JSON: {
  "promptCalendarButtons": { "userName": null, "contextMessage": null },
  "replyMessage": "Sending you the buttons now - check your DMs!",
  "markTopicInactive": true,
  "reasoning": "User confirmed, sending connection buttons"
}

### Pattern 3: Check other user's availability, offer to reach out
User: "is Parker free tomorrow?"
→ Call showOtherUsersAvailability(["Parker Whitfill"], ...) (no JSON)
→ [Tool returns: Parker calendar not connected]
→ Return JSON: {
  "replyMessage": "Can't see Parker Whitfill's calendar - they haven't connected it. I can ask them to connect if you'd like.",
  "markTopicInactive": true,
  "reasoning": "Parker not connected, offering to reach out"
}

[NEW TURN]
User: "yes ask him"
→ Return JSON: {
  "promptCalendarButtons": {
    "userName": "Parker Whitfill",
    "contextMessage": "Anand Shah is asking you to connect your calendar so he can plan around your availability."
  },
  "replyMessage": "Sending Parker the connection buttons with a note from you.",
  "markTopicInactive": true,
  "reasoning": "User confirmed, sending buttons to Parker with context"
}

### Pattern 4: Direct request to reach out to someone
User: "ask Parker to connect his calendar"
→ Return JSON: {
  "promptCalendarButtons": {
    "userName": "Parker Whitfill",
    "contextMessage": "Anand Shah is asking you to connect your calendar so he can plan around your availability."
  },
  "replyMessage": "Sending Parker the connection buttons now.",
  "markTopicInactive": true,
  "reasoning": "User directly requested, sending buttons to Parker"
}

## Important Rules
- ALWAYS set markTopicInactive to true (calendar-support topics are short-lived)
- When tool calls are needed, make ONLY the tool call (no JSON)
- After tool returns, THEN return JSON with appropriate response
- When sending buttons to another user, ALWAYS include contextMessage explaining who is asking
- Use exact names from User Directory for userName field
- Keep replyMessage brief (1-2 sentences)
- Don't schedule meetings or create events (that's scheduling agent's job)`,
})