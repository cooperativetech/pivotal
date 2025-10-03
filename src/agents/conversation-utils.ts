import { z } from 'zod'
import { RRuleTemporal } from 'rrule-temporal'
import { toText } from 'rrule-temporal/totext'
import { Temporal } from '@js-temporal/polyfill'

import type { RunContext } from './agent-sdk'
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
export const ConversationRes = z.strictObject({
  replyMessage: z.string().optional().nullable(),
  markTopicInactive: z.boolean().optional().nullable(),
  messagesToUsers: z.array(z.strictObject({
    userNames: z.array(z.string()),
    text: z.string(),
  })).optional().nullable(),
  groupMessage: z.string().optional().nullable(),
  finalizedEvent: CalendarEvent.optional().nullable(),
  cancelEvent: z.boolean().optional().nullable(),
  promptCalendarButtons: z.strictObject({
    userName: z.string().optional().nullable(),
    contextMessage: z.string().optional().nullable(),
    force: z.boolean().optional().nullable(),
  }).optional().nullable(),
  reasoning: z.string(),
})
export const ConversationAgent = Agent<ConversationContext, typeof ConversationRes>
export type ConversationRes = z.infer<typeof ConversationRes>
export type ConversationAgent = InstanceType<typeof ConversationAgent>

type AgentsErrorWithState = Error & { state?: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractAssistantOutputFromState(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined
  const response = state._lastTurnResponse
  if (!isRecord(response)) return undefined
  const output = response.output
  if (!Array.isArray(output)) return undefined

  const outputItems: unknown[] = output

  for (let i = outputItems.length - 1; i >= 0; i -= 1) {
    const item = outputItems[i]
    if (!isRecord(item)) continue
    const messageCandidate = item as {
      type?: unknown,
      role?: unknown,
      content?: unknown,
    }
    if (messageCandidate.type !== 'message') continue
    if (messageCandidate.role !== 'assistant') continue
    const content = messageCandidate.content
    if (!Array.isArray(content) || content.length === 0) continue
    const contentItems: unknown[] = content
    const lastChunk = contentItems[contentItems.length - 1]
    if (!isRecord(lastChunk)) continue
    const chunkCandidate = lastChunk as {
      type?: unknown,
      text?: unknown,
    }
    if (chunkCandidate.type !== 'output_text') continue
    if (typeof chunkCandidate.text === 'string') {
      return chunkCandidate.text
    }
  }

  return undefined
}

function sanitizeFencedJson(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const withoutFence = trimmed.replace(/^```[a-zA-Z]*\s*/, '')
  const closingIndex = withoutFence.lastIndexOf('```')
  if (closingIndex === -1) return withoutFence
  return withoutFence.slice(0, closingIndex).trim()
}

type InvalidOutputAnalysis = {
  preview?: string,
  issues: string[],
}

const INVALID_PREVIEW_LIMIT = 600

function analyseInvalidStructuredOutput(rawText?: string): InvalidOutputAnalysis {
  if (!rawText) {
    return {
      preview: undefined,
      issues: ['No assistant JSON output was returned.'],
    }
  }

  const preview = rawText.length > INVALID_PREVIEW_LIMIT
    ? `${rawText.slice(0, INVALID_PREVIEW_LIMIT)}…`
    : rawText

  const issues: string[] = []

  const sanitised = sanitizeFencedJson(rawText)

  let parsed: unknown
  try {
    parsed = JSON.parse(sanitised)
  } catch (error) {
    issues.push(`Response was not valid JSON (${error instanceof Error ? error.message : 'unknown parse error'})`)
    return { preview, issues }
  }

  if (!parsed || typeof parsed !== 'object') {
    issues.push('Response must be a JSON object matching the schema.')
    return { preview, issues }
  }

  const reasoning = (parsed as { reasoning?: unknown }).reasoning
  if (typeof reasoning !== 'string') {
    issues.push('`reasoning` is required and must be a string (use a short explanation).')
  }

  if ('replyMessage' in parsed) {
    const replyMessage = (parsed as { replyMessage: unknown }).replyMessage
    const validReply = typeof replyMessage === 'string' || replyMessage === null
    if (!validReply) {
      issues.push('`replyMessage` must be a string (use "" when waiting) or null.')
    }
  }

  return { preview, issues }
}

function formatRetryGuidance(preview?: string, issues: string[] = []): string {
  if (!preview && issues.length === 0) return ''
  const hints: string[] = []
  if (preview) {
    hints.push(`Your previous response was:
${preview}`)
  }
  if (issues.length > 0) {
    hints.push(`Fix the following problems before responding again: ${issues.join(' ')}`)
  }
  return `

Additional guidance based on your last response:
${hints.join('\n\n')}`
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

Based on the conversation history and current message, determine the next step in the scheduling workflow and generate the appropriate response.`

  console.log(`User prompt: ${userPrompt}`)

  const MAX_ATTEMPTS = 2
  const retryReminder = '\n\nIMPORTANT: Your previous response was not valid structured output.\n- If you still need information from a tool, call the tool now and output nothing else.\n- Otherwise, return ONLY the JSON object that matches the required schema (replyMessage, markTopicInactive, messagesToUsers, groupMessage, finalizedEvent, cancelEvent, reasoning).\n- replyMessage must be a string (use "" when you have nothing to add) and reasoning is ALWAYS required.\n- Never mix tool calls with JSON in the same response, and do not include any extra text before or after the JSON.'

  let lastInvalidPreview: string | undefined
  let lastInvalidIssues: string[] = []

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const retryDetails = attempt === 0 ? '' : formatRetryGuidance(lastInvalidPreview, lastInvalidIssues)
    const promptToUse = attempt === 0
      ? userPrompt
      : `${userPrompt}${retryReminder}${retryDetails}`

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
      const isInvalidOutput = error instanceof Error && error.message.includes('Invalid output type')
      const errorSummary = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      const stackPreview = error instanceof Error && typeof error.stack === 'string'
        ? error.stack.split('\n').slice(0, 5).join('\n')
        : 'No stack trace'

      if (isInvalidOutput) {
        const state = (error as AgentsErrorWithState).state
        const rawOutput = extractAssistantOutputFromState(state)
        const analysis = analyseInvalidStructuredOutput(rawOutput)
        lastInvalidPreview = analysis.preview
        lastInvalidIssues = analysis.issues

        if (analysis.preview) {
          console.warn('[ConversationAgent] Invalid output preview (truncated):', analysis.preview)
        }
        if (analysis.issues.length > 0) {
          console.warn('[ConversationAgent] Detected structured output issues:', analysis.issues.join(' '))
        }

        console.warn(`[ConversationAgent] Invalid structured output (attempt ${attempt + 1}/${MAX_ATTEMPTS}). Summary: ${errorSummary}`)
        console.warn('[ConversationAgent] Stack preview:', stackPreview)
        if (attempt === 0) {
          console.warn('[ConversationAgent] Retrying with explicit JSON instructions.')
          continue
        }
      }

      console.error('=== ERROR IN runConversationAgent ===')
      console.error('Error type:', error instanceof Error ? error.constructor.name : typeof error)
      console.error('Error message:', error instanceof Error ? error.message : String(error))
      console.error('Stack trace:', stackPreview)
      console.error('Full error object:', JSON.stringify(error, null, 2))
      console.error('=================================')

      return {
        replyMessage: 'I encountered an error processing your message. Please try sending it again. If the issue persists, contact support.',
        reasoning: `Error occurred: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }
    }
  }

  // Fallback (should not reach here due to return in loop)
  return {
    replyMessage: 'I encountered an error processing your message. Please try sending it again. If the issue persists, contact support.',
    reasoning: 'Error occurred: retry limit reached',
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
