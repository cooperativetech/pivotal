import { z } from 'zod'

import { tool } from './agent-sdk'
import type { RunContext } from './agent-sdk'
import type { ConversationContext } from './conversation-utils'
import { ConversationAgent, ConversationRes } from './conversation-utils'
import { isGoogleCalendarConnected } from '../integrations/google'
import { findMeetingsForUsers } from '../meeting-artifacts'
import { getUserCalendarStructured } from '../calendar-service'
import { formatTimestampWithTimezone } from '../utils'
import { Temporal } from '@js-temporal/polyfill'
import db from '../db/engine'
import { slackMessageTable, slackChannelTable } from '../db/schema/main'
import { eq } from 'drizzle-orm'
import { findCommonFreeTime, convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import type { UserProfile as CalendarIntersectionProfile } from '../tools/time_intersection'

function formatDurationMinutes(minutesTotal: number): string {
  if (minutesTotal <= 1) return '1 minute'
  if (minutesTotal < 60) return `${minutesTotal} minutes`
  const hours = Math.floor(minutesTotal / 60)
  const minutes = minutesTotal % 60
  if (minutes === 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${hours}h ${minutes}m`
}

function describeElapsedSince(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime()
  if (diffMs < 0) return 'in the future'
  const diffMinutes = Math.floor(diffMs / (60_000))
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    const remainMinutes = diffMinutes % 60
    if (remainMinutes === 0) return `${diffHours} hours ago`
    return `${diffHours}h ${remainMinutes}m ago`
  }
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  const diffWeeks = Math.floor(diffDays / 7)
  return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]
    if (predicate(candidate)) {
      return candidate
    }
  }
  return null
}

type AvailabilityParticipantSummary = {
  name: string
  status: 'ok' | 'no_calendar_data' | 'error'
  detail?: string
  busyBlockCount?: number
}

type AvailabilityFreeBlock = {
  start: string
  startLocal: string
  end: string
  endLocal: string
  durationMinutes: number
  durationReadable: string
}

type AvailabilityPayload = {
  window: {
    start: string
    end: string
    timezone: string
  }
  participants: AvailabilityParticipantSummary[]
  unresolvedNames: string[]
  freeBlocks: AvailabilityFreeBlock[]
  note?: string
}

const checkCalendarConnection = tool({
  name: 'checkCalendarConnection',
  description: 'Check whether specified Slack users have their Google Calendar connected. Pass exact real names from the User Directory. Leave the list empty to check only the requesting user.',
  parameters: z.strictObject({
    userNames: z.array(z.string()).describe('Exact real names of the users to check. Use the User Directory names. Leave empty to check the requester.'),
  }),
  execute: async ({ userNames }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message, userMap } = runContext.context

    const results: string[] = []
    const pendingIds: Array<{ userId: string, name: string }> = []

    if (userNames.length === 0) {
      const selfName = userMap.get(message.userId)?.realName ?? 'You'
      pendingIds.push({ userId: message.userId, name: selfName })
    } else {
      for (const requestedName of userNames) {
        let matchedId: string | undefined
        let matchedRealName: string | undefined
        for (const [candidateId, candidate] of userMap.entries()) {
          const realName = candidate.realName || ''
          if (realName && realName.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0) {
            matchedId = candidateId
            matchedRealName = realName
            break
          }
        }

        if (!matchedId) {
          results.push(`${requestedName}: user not found in directory.`)
          continue
        }

        pendingIds.push({ userId: matchedId, name: matchedRealName ?? requestedName })
      }
    }

    const lines: string[] = []

    for (const target of pendingIds) {
      try {
        const connected = await isGoogleCalendarConnected(target.userId)
        lines.push(`${target.name}: ${connected ? '✅ Connected' : '❌ Not connected'}`)
      } catch (error) {
        lines.push(`${target.name}: Unable to check (${error instanceof Error ? error.message : 'unknown error'})`)
      }
    }

    return lines.join('\n')
  },
})

const lookupMeetings = tool({
  name: 'lookupMeetings',
  description: 'Retrieve meetings recorded by Pivotal for specified users. Useful for questions like "What\'s my next meeting?" or "Send me the meeting link again."',
  parameters: z.strictObject({
    userNames: z.array(z.string()).optional().default([]).describe('Exact real names (from the User Directory) to find meetings for. Leave empty to reference the requesting user.'),
    summaryContains: z.string().optional().nullable().describe('Optional text to match within the meeting summary (case-insensitive).'),
    direction: z.enum(['upcoming', 'past']).optional().default('upcoming').describe('Whether to look for upcoming or past meetings.'),
    limit: z.number().int().positive().max(10).optional().default(3).describe('Maximum number of meetings to return.'),
  }),
  execute: async ({ userNames, summaryContains, direction, limit }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message, userMap, callingUserTimezone } = runContext.context

    const targetIds: { id: string, name: string }[] = []
    const missingNames: string[] = []
    if (userNames.length === 0) {
      targetIds.push({ id: message.userId, name: userMap.get(message.userId)?.realName || 'You' })
    } else {
      for (const requestedName of userNames) {
        const match = Array.from(userMap.entries()).find(([, user]) => {
          const realName = user.realName || ''
          return realName.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0
        })

        if (!match) {
          missingNames.push(requestedName)
          continue
        }
        targetIds.push({ id: match[0], name: match[1].realName || requestedName })
      }
    }

    if (targetIds.length === 0) {
      if (missingNames.length > 0) {
        return `Could not find these users in the directory: ${missingNames.join(', ')}`
      }
      return 'No users specified to search for meetings.'
    }

    const meetings = await findMeetingsForUsers({
      userIds: targetIds.map((entry) => entry.id),
      direction,
      summaryContains: summaryContains ?? undefined,
      limit,
    })

    if (meetings.length === 0) {
      return 'No meetings found that match those criteria.'
    }

    const lines: string[] = []
    meetings.forEach(({ artifact, topic }, index) => {
      const summary = artifact.summary || topic.state.summary || 'Meeting'
      const start = formatTimestampWithTimezone(artifact.startTime, callingUserTimezone)
      const end = formatTimestampWithTimezone(artifact.endTime, callingUserTimezone)
      const participantNames = topic.state.userIds
        .map((id) => userMap.get(id)?.realName || id)
        .join(', ')
      const linkLine = artifact.meetingUri ? `\n  Link: ${artifact.meetingUri}` : ''
      const topicLine = `\n  Topic ID: ${topic.id}`

      lines.push(`${index + 1}. ${summary}\n  When: ${start} – ${end}\n  Participants: ${participantNames}${linkLine}${topicLine}`)
    })

    return lines.join('\n\n')
  },
})

const getCalendarEvents = tool({
  name: 'getCalendarEvents',
  description: 'Fetch upcoming or recent calendar events (including busy blocks) directly from connected calendars. Provide a time range to inspect.',
  parameters: z.strictObject({
    userNames: z.array(z.string()).optional().default([]).describe('Exact real names (from the User Directory). Leave empty to use the requester.'),
    rangeHours: z.number().int().positive().max(24 * 30).optional().default(24 * 7).describe('How many hours ahead to look (default 7 days).'),
    includePastHours: z.number().int().min(0).max(24 * 7).optional().default(0).describe('How many hours back to include (default 0).'),
  }),
  execute: async ({ userNames, rangeHours, includePastHours }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { message, topic, userMap, callingUserTimezone } = runContext.context

    const targets: { id: string, name: string }[] = []
    const notFound: string[] = []

    if (userNames.length === 0) {
      targets.push({ id: message.userId, name: userMap.get(message.userId)?.realName || 'You' })
    } else {
      for (const requestedName of userNames) {
        const match = Array.from(userMap.entries()).find(([, user]) => {
          const realName = user.realName || ''
          return realName.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0
        })
        if (!match) {
          notFound.push(requestedName)
          continue
        }
        targets.push({ id: match[0], name: match[1].realName || requestedName })
      }
    }

    if (targets.length === 0) {
      return notFound.length > 0
        ? `Could not find these users in the directory: ${notFound.join(', ')}`
        : 'No users specified to search for events.'
    }

    const now = Temporal.Now.instant()
    const start = includePastHours > 0
      ? now.subtract({ hours: includePastHours })
      : now
    const end = now.add({ hours: rangeHours })

    const lines: string[] = []

    for (const target of targets) {
      try {
        const events = await getUserCalendarStructured(
          target.id,
          topic,
          new Date(start.epochMilliseconds),
          new Date(end.epochMilliseconds),
        )

        if (!events || events.length === 0) {
          lines.push(`${target.name}: No events found in the requested window.`)
          continue
        }

        const formatted = events
          .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
          .map((event, idx) => {
            const startStr = formatTimestampWithTimezone(new Date(event.start), callingUserTimezone)
            const endStr = formatTimestampWithTimezone(new Date(event.end), callingUserTimezone)
            const title = event.summary || (event.free ? 'Available' : 'Busy')
            const participants = event.participantEmails?.length ? `\n      Participants: ${event.participantEmails.join(', ')}` : ''
            return `    ${idx + 1}. ${title}\n      When: ${startStr} – ${endStr}${participants}`
          })

        lines.push(`${target.name}:\n${formatted.join('\n')}`)
      } catch (error) {
        lines.push(`${target.name}: Unable to fetch events (${error instanceof Error ? error.message : 'unknown error'})`)
      }
    }

    if (notFound.length > 0) {
      lines.push(`Could not find: ${notFound.join(', ')}`)
    }

    return lines.join('\n\n')
  },
})

const findCommonAvailability = tool({
  name: 'findCommonAvailability',
  description: 'Find overlapping free time for multiple users within a specific window. Useful for questions like "When are Parker and I both free tomorrow?"',
  parameters: z.strictObject({
    userNames: z.array(z.string()).min(1).describe('Exact real names (from the User Directory) to include in the overlap calculation. The requester must be included explicitly if you want them considered.'),
    startTime: z.string().describe('ISO 8601 timestamp for the start of the window (e.g., "2025-10-02T13:00:00-04:00").'),
    endTime: z.string().describe('ISO 8601 timestamp for the end of the window. Must be later than startTime.'),
    minBlockMinutes: z.number().int().min(5).max(24 * 60).optional().default(30).describe('Only return free blocks that are at least this many minutes long (default 30 minutes).'),
    maxResults: z.number().int().min(1).max(10).optional().default(5).describe('Maximum number of free blocks to return (default 5).'),
  }),
  execute: async ({ userNames, startTime, endTime, minBlockMinutes, maxResults }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { topic, userMap, callingUserTimezone } = runContext.context

    const start = new Date(startTime)
    const end = new Date(endTime)

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return 'Invalid startTime or endTime. Provide ISO timestamps such as 2025-10-02T13:00:00-04:00.'
    }
    if (end <= start) {
      return 'endTime must be after startTime.'
    }

    const nameToId = new Map<string, string>()
    userMap.forEach((user, id) => {
      if (user.realName) {
        nameToId.set(user.realName, id)
      }
    })

    const targets: Array<{ id: string, name: string }> = []
    const unresolvedNames: string[] = []
    userNames.forEach((requestedName) => {
      const matchEntry = Array.from(userMap.entries()).find(([, user]) => {
        const realName = user.realName || ''
        return realName.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0
      })
      if (!matchEntry) {
        unresolvedNames.push(requestedName)
        return
      }
      targets.push({ id: matchEntry[0], name: matchEntry[1].realName || requestedName })
    })

    if (targets.length === 0) {
      return unresolvedNames.length > 0
        ? `No calendars available. Could not resolve: ${unresolvedNames.join(', ')}`
        : 'No users provided to compare availability.'
    }

    const timelines = await Promise.all(targets.map(async (target) => {
      try {
        const events = await getUserCalendarStructured(target.id, topic, start, end)
        if (events === null) {
          return { target, events: null }
        }
        return { target, events }
      } catch (error) {
        return {
          target,
          error: error instanceof Error ? error.message : 'unknown error',
        }
      }
    }))

    const profiles: CalendarIntersectionProfile[] = []
    const participantSummaries: AvailabilityParticipantSummary[] = []
    timelines.forEach((entry) => {
      if ('error' in entry) {
        participantSummaries.push({
          name: entry.target.name,
          status: 'error',
          detail: entry.error,
        })
        return
      }
      if (entry.events === null) {
        participantSummaries.push({
          name: entry.target.name,
          status: 'no_calendar_data',
        })
        return
      }
      const converted = convertCalendarEventsToUserProfile(entry.events)
      profiles.push({ name: entry.target.name, calendar: converted })
      participantSummaries.push({
        name: entry.target.name,
        status: 'ok',
        busyBlockCount: converted.length,
      })
    })

    if (profiles.length === 0) {
      const notes = timelines.map((entry) => {
        if ('error' in entry) {
          return `${entry.target.name}: error fetching calendar (${entry.error})`
        }
        return `${entry.target.name}: no calendar data available`
      })
      const prefix = unresolvedNames.length > 0 ? `Could not resolve: ${unresolvedNames.join(', ')}. ` : ''
      return `${prefix}No overlapping availability can be calculated because no calendars were accessible.\n${notes.join('\n')}`
    }

    const commonFree = findCommonFreeTime(profiles, start, end)
      .map((slot) => {
        const durationMinutes = Math.floor((slot.end.getTime() - slot.start.getTime()) / 60000)
        return {
          start: slot.start,
          end: slot.end,
          durationMinutes,
        }
      })
      .filter((slot) => slot.durationMinutes >= minBlockMinutes)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, maxResults)

    const payload: AvailabilityPayload = {
      window: {
        start: start.toISOString(),
        end: end.toISOString(),
        timezone: callingUserTimezone,
      },
      participants: participantSummaries,
      unresolvedNames,
      freeBlocks: commonFree.map((slot) => ({
        start: slot.start.toISOString(),
        startLocal: formatTimestampWithTimezone(slot.start, callingUserTimezone),
        end: slot.end.toISOString(),
        endLocal: formatTimestampWithTimezone(slot.end, callingUserTimezone),
        durationMinutes: slot.durationMinutes,
        durationReadable: formatDurationMinutes(slot.durationMinutes),
      })),
    }

    if (payload.freeBlocks.length === 0) {
      payload.note = 'No overlapping free time found in the requested window.'
    }

    return JSON.stringify(payload, null, 2)
  },
})

const getParticipantResponseStatus = tool({
  name: 'getParticipantResponseStatus',
  description: 'Summarize who has responded in the current scheduling topic. Helpful for questions like "Did Ben respond?" or deciding who to nudge.',
  parameters: z.strictObject({
    userNames: z.array(z.string()).optional().default([]).describe('Exact real names (from the User Directory). Leave empty to include all human participants in the topic.'),
  }),
  execute: async ({ userNames }, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')
    const { topic, userMap, callingUserTimezone } = runContext.context

    const participants: Array<{ id: string, name: string }> = []
    const unresolvedNames: string[] = []

    if (userNames.length === 0) {
      for (const userId of topic.state.userIds) {
        if (userId === topic.botUserId) continue
        const user = userMap.get(userId)
        if (!user || user.isBot || !user.realName) continue
        participants.push({ id: userId, name: user.realName })
      }
    } else {
      userNames.forEach((requestedName) => {
        const matchEntry = Array.from(userMap.entries()).find(([, user]) => {
          const realName = user.realName || ''
          return realName.localeCompare(requestedName, undefined, { sensitivity: 'base' }) === 0
        })
        if (!matchEntry || matchEntry[0] === topic.botUserId) {
          unresolvedNames.push(requestedName)
          return
        }
        const user = matchEntry[1]
        if (user.isBot || !user.realName) {
          unresolvedNames.push(requestedName)
          return
        }
        participants.push({ id: matchEntry[0], name: user.realName })
      })
    }

    if (participants.length === 0) {
      const unresolvedStr = unresolvedNames.length > 0 ? ` Could not resolve: ${unresolvedNames.join(', ')}.` : ''
      return `No human participants found to analyze.${unresolvedStr}`
    }

    const messageRows = await db
      .select({ message: slackMessageTable, channel: slackChannelTable })
      .from(slackMessageTable)
      .leftJoin(slackChannelTable, eq(slackMessageTable.channelId, slackChannelTable.id))
      .where(eq(slackMessageTable.topicId, topic.id))
      .orderBy(slackMessageTable.timestamp)

    const now = new Date()

    const participantDetails = participants.map((participant) => {
      const lastOutgoing = findLast(messageRows, (row) => {
        if (row.message.userId !== topic.botUserId) return false
        const channelUsers = row.channel?.userIds || []
        return channelUsers.length === 1 && channelUsers.includes(participant.id)
      })

      const lastUserMessageOverall = findLast(messageRows, (row) => row.message.userId === participant.id)

      const lastUserMessageAfterOutreach = lastOutgoing
        ? findLast(messageRows, (row) => row.message.userId === participant.id && row.message.timestamp > lastOutgoing.message.timestamp)
        : lastUserMessageOverall

      const awaitingResponse = Boolean(lastOutgoing) && !lastUserMessageAfterOutreach

      return {
        name: participant.name,
        status: awaitingResponse ? 'waiting' : 'responded',
        lastOutreachIso: lastOutgoing ? lastOutgoing.message.timestamp.toISOString() : null,
        lastOutreachLocal: lastOutgoing ? formatTimestampWithTimezone(lastOutgoing.message.timestamp, callingUserTimezone) : null,
        lastOutreachText: lastOutgoing?.message.text ?? null,
        lastResponseIso: lastUserMessageAfterOutreach ? lastUserMessageAfterOutreach.message.timestamp.toISOString() : null,
        lastResponseLocal: lastUserMessageAfterOutreach ? formatTimestampWithTimezone(lastUserMessageAfterOutreach.message.timestamp, callingUserTimezone) : null,
        lastResponseText: lastUserMessageAfterOutreach?.message.text ?? null,
        lastResponseAgo: lastUserMessageAfterOutreach ? describeElapsedSince(lastUserMessageAfterOutreach.message.timestamp, now) : null,
        waitingSince: awaitingResponse && lastOutgoing ? describeElapsedSince(lastOutgoing.message.timestamp, now) : null,
        latestUserMessageText: lastUserMessageOverall?.message.text ?? null,
      }
    })

    const pending = participantDetails
      .filter((detail) => detail.status === 'waiting')
      .map((detail) => detail.name)

    const payload = {
      participants: participantDetails,
      pending,
      unresolvedNames,
      summary: pending.length > 0
        ? `Waiting on: ${pending.join(', ')}`
        : 'All tracked participants have responded since the last outreach.',
    }

    return JSON.stringify(payload, null, 2)
  },
})

const baseInstructions = `You are Pivotal's queries assistant. Your responsibility is to answer user questions precisely and concisely using the conversation history, topic summary, and any tools provided. Always reply when a user reaches out—never leave a direct question unanswered.

Guidelines:
- Call the available tools whenever you need fresh or authoritative data (e.g., checkCalendarConnection for calendar status questions).
- Prioritize factual responses grounded in the provided context or tool outputs.
- When you lack sufficient information, say so explicitly and suggest the next step the platform or user could take to obtain it.
- Reference the evidence you used ("conversation history", tool names, etc.) when it helps the user understand your answer.
- Avoid fabricating details or making assumptions beyond what is supported.
- When checking calendar status, call checkCalendarConnection and keep the response concise (✅/❌). If you can’t identify the linked account from the data available, tell the user to check their account settings.
- For meeting-related questions (next meeting, meeting link, meeting purpose), call lookupMeetings to check Pivotal-managed meetings, and call getCalendarEvents when you need the full calendar (busy slots, external events) within a specific time window.
- For cross-user availability or mutual free-time questions, call findCommonAvailability with an explicit ISO start and end window and include every person that should be considered.
- For status updates (“Did Ben respond?”, “Who are we waiting on?”) or before sending follow-up nudges, call getParticipantResponseStatus and use its JSON payload to ground your answer and determine who still needs a ping.
- When sending nudges, only include users who are actually outstanding according to the latest status data, and respect user requests when crafting the DM text.
- When a user explicitly asks for the connection buttons—or clearly agrees that they want them—include "promptCalendarButtons": { "userName": "Exact Real Name" } in your final JSON so the platform knows who to prompt. Use the exact real name from the User Directory (e.g., "Anand Shah"). Add "force": true only if the user explicitly asks you to resend the buttons after already receiving them. Otherwise, omit this field.`

export const queryAgent = new ConversationAgent({
  name: 'queryAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0.2,
  },
  tools: [
    checkCalendarConnection,
    lookupMeetings,
    getCalendarEvents,
    findCommonAvailability,
    getParticipantResponseStatus,
  ],
  outputType: ConversationRes,
  instructions: (runContext: RunContext<ConversationContext>) => {
    const { topic, userMap } = runContext.context
    const userDirectory = Array.from(userMap.values())
      .filter((user) => !user.isBot && user.realName)
      .map((user) => user.realName as string)
      .sort()
      .join(', ')

    const topicSummary = topic.state.summary ?? 'No summary available.'

    return `${baseInstructions}

    User Directory (real names):
${userDirectory || 'No human users known.'}

    Current topic summary:
${topicSummary}`
  },
})
