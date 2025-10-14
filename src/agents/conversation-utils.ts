import { z } from 'zod'
import { RRuleTemporal } from 'rrule-temporal'
import { toText } from 'rrule-temporal/totext'
import { Temporal } from '@js-temporal/polyfill'

import type { AgentOptions, RunContext } from './agent-sdk'
import { Agent, Runner, tool } from './agent-sdk'
import db from '../db/engine'
import type { SlackMessage, SlackUser, AutoMessageInsert } from '../db/schema/main'
import { autoMessageTable } from '../db/schema/main'
import type { TopicWithState } from '@shared/api-types'
import {
  tsToDate,
  organizeMessagesByChannelAndThread,
  replaceUserMentions,
  getChannelDescription,
  formatTimestampWithTimezone,
  updateTopicState,
} from '../utils'
import { getShortTimezoneFromIANA } from '@shared/utils'
import { getUserCalendarStructured } from '../calendar-service'
import { CalendarEvent } from '@shared/api-types'

export interface ConversationContext {
  message: SlackMessage,
  topic: TopicWithState,
  userMap: Map<string, SlackUser>,
  callingUserTimezone: string,
}

const ConversationRes = z.strictObject({
  replyMessage: z.string().optional().nullable().describe('Optional message text to reply to the user in the current channel/thread'),
  markTopicInactive: z.boolean().optional().nullable().describe('Set to true when the topic is complete and should be marked as inactive'),
  messagesToUsers: z.array(z.strictObject({
    userNames: z.array(z.string()).describe('Exact full names from User Directory to send this message to as individual 1-1 DMs'),
    text: z.string().describe('The message text to send to each user as a private DM'),
  })).optional().nullable().describe('Array of private 1-1 DM messages to send to specific users'),
  groupMessage: z.string().optional().nullable().describe('Message to send to the shared channel with all topic participants'),
  finalizedEvent: CalendarEvent.optional().nullable().describe('Calendar event details when finalizing a meeting time (includes start, end, summary)'),
  cancelEvent: z.boolean().optional().nullable().describe('Set to true when cancelling an existing calendar event'),
  promptCalendarButtons: z.strictObject({
    userName: z.string().optional().nullable().describe('Exact real name from User Directory of the user to prompt for calendar connection'),
    contextMessage: z.string().optional().nullable().describe('Optional context message to show with the calendar connection buttons'),
  }).optional().nullable().describe('Prompt a user to connect their calendar with connection buttons'),
})
type ConversationRes = z.infer<typeof ConversationRes>

const ConversationAgent = Agent<ConversationContext, typeof ConversationRes>
export type ConversationAgent = InstanceType<typeof ConversationAgent>

const conversationOutputTool = tool({
  name: 'output',
  description: 'Return your final response. Always call this tool as your final output, without outputting any other text.',
  parameters: ConversationRes,
  execute: (params) => params,
})

export function makeConversationAgent(
  config: AgentOptions<ConversationContext, typeof ConversationRes>,
): ConversationAgent {
  // Validate that conflicting properties are not set
  if (config.modelSettings && 'toolChoice' in config.modelSettings) {
    throw new Error(
      'makeConversationAgent automatically sets modelSettings.toolChoice. ' +
      'This property cannot be manually specified.',
    )
  }
  if ('outputType' in config || 'toolUseBehavior' in config || 'resetToolChoice' in config) {
    throw new Error(
      'makeConversationAgent automatically sets outputType, toolUseBehavior, and resetToolChoice. ' +
      'These properties cannot be manually specified.',
    )
  }

  // Pass through the config with modifications
  return new ConversationAgent({
    ...config,
    tools: [...(config.tools || []), conversationOutputTool],
    outputType: ConversationRes,
    modelSettings: {
      ...config.modelSettings,
      toolChoice: 'required',
    },
    resetToolChoice: false,
    toolUseBehavior: { stopAtToolNames: ['output'] },
  })
}

export async function runConversationAgent(
  agent: ConversationAgent,
  message: SlackMessage,
  topic: TopicWithState,
  previousMessages: SlackMessage[],
  userMap: Map<string, SlackUser>,
): Promise<ConversationRes> {
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

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.

For context, the current day and time is: ${formatTimestampWithTimezone(message.timestamp, callingUserTimezone, true)}`

  console.log(`User prompt: ${userPrompt}`)

  const MAX_ATTEMPTS = 2
  const retryReminder = '\n\nIMPORTANT: You must call the `output` tool to provide your response. Do not output anything else. If you need to call other tools first, do so, then call the `output` tool.'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const promptToUse = attempt === 0 ? userPrompt : `${userPrompt}${retryReminder}`

    try {
      const runner = new Runner({ groupId: `topic-${topic.id}` })
      const result = await runner.run(
        agent,
        promptToUse,
        { context: { message, topic, userMap, callingUserTimezone } },
      )
      if (!result.finalOutput) {
        throw new Error('No finalOutput generated')
      }
      return result.finalOutput
    } catch (error) {
      console.error(`=== ERROR IN runConversationAgent (attempt ${attempt + 1}/${MAX_ATTEMPTS}) ===`)
      console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
      console.error('Error message:', error instanceof Error ? error.message : String(error))
      console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace')
      console.error('Full error object:', JSON.stringify(error, null, 2))
      console.error('=================================')

      // If this was the last attempt, return error response
      if (attempt === MAX_ATTEMPTS - 1) {
        return {
          replyMessage: 'I encountered an error processing your message. Please try sending it again. If the issue persists, contact support.',
        }
      }

      // Otherwise, retry with the reminder
      console.warn('[ConversationAgent] Retrying with output tool reminder')
    }
  }

  // Fallback (should not reach here due to return in loop)
  return {
    replyMessage: 'I encountered an error processing your message. Please try sending it again. If the issue persists, contact support.',
  }
}

export const updateUserNames = tool({
  name: 'updateUserNames',
  description: 'Update the list of users involved in the topic. Provide the COMPLETE list of user names who should be involved going forward (this replaces the existing list).',
  parameters: z.strictObject({
    userNames: z.array(z.string()).describe('Complete list of user names who should be involved (use exact names from User Directory)'),
  }),
  execute: async ({ userNames }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: updateUserNames with names:', userNames)

    if (!runContext) throw new Error('runContext not provided')
    const { message, topic, userMap } = runContext.context

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

    // Update the topic state with the new user IDs
    const updatedTopic = await updateTopicState(
      topic,
      { userIds: updatedUserIds },
      message.id,
    )

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    // Map IDs back to names for the response
    const updatedUserNames = updatedUserIds.map((id) => userMap.get(id)?.realName || id)
    return `Updated user list to: ${updatedUserNames.join(', ')}`
  },
})

export const updateSummary = tool({
  name: 'updateSummary',
  description: 'Update the topic summary when new information clarifies or changes the topic details.',
  parameters: z.strictObject({
    summary: z.string().describe('The updated topic summary'),
  }),
  execute: async ({ summary }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: updateSummary with summary:', summary)

    if (!runContext) throw new Error('runContext not provided')
    const { message, topic } = runContext.context

    // Update the topic in the database with the new summary
    const updatedTopic = await updateTopicState(topic, { summary }, message.id)

    // Update runContext with the updated topic
    runContext.context.topic = updatedTopic

    return `Updated topic summary to: ${summary}`
  },
})

export const showUserCalendar = tool({
  name: 'showUserCalendar',
  description: 'Show a user\'s calendar events for a specified time range',
  parameters: z.strictObject({
    slackUserName: z.string().describe('The Slack user\'s real name (use exact name from User Directory)'),
    startTime: z.string().describe('ISO 8601 datetime string for the start of the time range'),
    endTime: z.string().describe('ISO 8601 datetime string for the end of the time range'),
  }),
  execute: async ({ slackUserName, startTime, endTime }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: showUserCalendar with:', { slackUserName, startTime, endTime })

    if (!runContext) throw new Error('runContext not provided')
    const { topic, userMap } = runContext.context

    // Map name to user ID
    let slackUserId: string | undefined
    for (const [id, user] of userMap.entries()) {
      if (user.realName === slackUserName) {
        slackUserId = id
        break
      }
    }
    if (!slackUserId) {
      throw new Error(`Could not find user ID for name: ${slackUserName}`)
    }

    // Parse the ISO strings to Dates
    const startTimeDate = new Date(startTime)
    const endTimeDate = new Date(endTime)

    if (isNaN(startTimeDate.getTime())) {
      throw new Error(`Invalid start datetime string: ${startTime}`)
    }
    if (isNaN(endTimeDate.getTime())) {
      throw new Error(`Invalid end datetime string: ${endTime}`)
    }

    // Get the user's calendar
    const calendarEvents = await getUserCalendarStructured(slackUserId, topic, startTimeDate, endTimeDate)

    // Get user information for display
    const user = userMap.get(slackUserId)
    const userName = user?.realName || slackUserId
    const userTz = user?.tz || 'UTC'

    // Create email to name mapping from userMap
    const emailToName = new Map<string, string>()
    for (const slackUser of userMap.values()) {
      if (slackUser.email && slackUser.realName) {
        emailToName.set(slackUser.email.toLowerCase(), slackUser.realName)
      }
    }

    if (calendarEvents === null) {
      return `${userName} does not have their calendar connected`
    } else if (calendarEvents.length === 0) {
      return `No calendar events found for ${userName} between ${formatTimestampWithTimezone(startTimeDate, userTz)} and ${formatTimestampWithTimezone(endTimeDate, userTz)}`
    }

    // Format calendar events grouped by local day with explicit indices for easier referencing
    const sortedEvents = [...calendarEvents].sort((a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime(),
    )

    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: userTz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: userTz,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    const timezoneAbbr = getShortTimezoneFromIANA(userTz)

    const groupedByDay = new Map<string, CalendarEvent[]>()
    const orderedDayLabels: string[] = []

    for (const event of sortedEvents) {
      const startDate = new Date(event.start)
      const dayLabel = dateFormatter.format(startDate)

      if (!groupedByDay.has(dayLabel)) {
        groupedByDay.set(dayLabel, [])
        orderedDayLabels.push(dayLabel)
      }

      groupedByDay.get(dayLabel)!.push(event)
    }

    const lines: string[] = [`Calendar for ${userName} (${timezoneAbbr}):`]
    let eventIndex = 1

    for (const dayLabel of orderedDayLabels) {
      lines.push(`${dayLabel}:`)

      const eventsForDay = groupedByDay.get(dayLabel) || []
      for (const event of eventsForDay) {
        const eventStart = new Date(event.start)
        const eventEnd = new Date(event.end)
        const freeStatus = event.free ? ' [Free]' : ''

        const timeRange = `${timeFormatter.format(eventStart)} - ${timeFormatter.format(eventEnd)} (${timezoneAbbr})`

        const participants = event.participantEmails?.length
          ? ` (with: ${event.participantEmails.map((email) =>
              emailToName.get(email.toLowerCase()) || email,
            ).join(', ')})`
          : ''

        lines.push(`  [${eventIndex}] ${timeRange}: ${event.summary}${freeStatus}${participants}`)
        eventIndex += 1
      }
    }

    return lines.join('\n')
  },
})

export const scheduleAutoMessage = tool({
  name: 'scheduleAutoMessage',
  description: 'Schedule an automatic message to send to myself at a specific time',
  parameters: z.strictObject({
    autoMessageText: z.string().describe('The text of the message to schedule'),
    sendTime: z.string().describe('ISO 8601 datetime string for when to send the message (e.g., "2024-12-25T10:30:00Z")'),
    startNewTopic: z.boolean().describe('Whether to start a new topic when sending this message'),
  }),
  execute: async ({ autoMessageText, sendTime, startNewTopic }, runContext?: RunContext<ConversationContext>) => {
    console.log('Tool called: scheduleAutoMessage with:', { autoMessageText, sendTime, startNewTopic })

    if (!runContext) throw new Error('runContext not provided')
    const { message } = runContext.context

    // Parse the ISO string to a Date
    const sendTimeDate = new Date(sendTime)
    if (isNaN(sendTimeDate.getTime())) {
      throw new Error(`Invalid datetime string: ${sendTime}`)
    }

    // Check if the date is in the past
    if (sendTimeDate < new Date()) {
      throw new Error(`Cannot schedule message in the past: ${sendTime}`)
    }

    // Convert the sendTime Date to a Temporal ZonedDateTime (using UTC)
    const zonedDateTime = Temporal.Instant
      .fromEpochMilliseconds(sendTimeDate.getTime())
      .toZonedDateTimeISO('UTC')

    // Create a single-occurrence RRule
    const rrule = new RRuleTemporal({
      freq: 'DAILY',
      count: 1,
      dtstart: zonedDateTime,
    })

    // Create the AutoMessage object
    const autoMessage: AutoMessageInsert = {
      text: autoMessageText,
      nextSendTime: sendTimeDate,
      recurrenceSchedule: {
        rrule: rrule.toString(),
        description: toText(rrule),
      },
      startNewTopic,
      createdByMessageId: message.id,
    }

    // Insert into database
    await db
      .insert(autoMessageTable)
      .values(autoMessage)
      .returning()

    return `Scheduled auto-message for ${sendTimeDate.toISOString()}: "${autoMessageText}" (start new topic: ${startNewTopic})`
  },
})
