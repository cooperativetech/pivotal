import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'

import type { RunContext } from './agent-sdk'
import { tool } from './agent-sdk'
import { formatTimestampWithTimezone, updateTopicState } from '../utils'
import { getShortTimezoneFromIANA, mergeCalendarWithOverrides } from '@shared/utils'
import { getWeekdayLabel } from '@shared/recurrence'
import { CalendarEvent } from '@shared/api-types'
import type { RecurringSlotScore, RecurringMetadata } from '@shared/api-types'
import type { ConversationContext } from './conversation-utils'
import { ConversationAgent, ConversationRes, updateSummary, updateUserNames } from './conversation-utils'
import { getUserCalendarStructured, listBotScheduledEvents, updateTopicUserContext } from '../calendar-service'
import { isGoogleCalendarConnected } from '../integrations/google'
import type { UserProfile } from '../tools/time_intersection'
import { findCommonFreeTime, convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { scoreRecurringSlots, summarizeIndividualConflicts } from '../tools/recurring-slots'

type RecurringRecommendation = 'proceed' | 'dm_blocker' | 'present_options' | 'suggest_alternatives'

function deriveRecurringRecommendation(scores: RecurringSlotScore[]): { recommendation: RecurringRecommendation; blockerUser?: string } {
  if (scores.length === 0) {
    return { recommendation: 'suggest_alternatives' }
  }

  const [best, ...rest] = scores
  const participants = Math.max(1, Object.keys(best.perPersonConflicts).length)
  const totalAttendanceSlots = best.totalOccurrences * participants
  const normalizedConflictRate = totalAttendanceSlots === 0 ? 0 : best.totalConflicts / totalAttendanceSlots

  const sortedIndividuals = Object.entries(best.perPersonConflicts).sort((a, b) => b[1] - a[1])
  const [topName, topConflicts] = sortedIndividuals[0]
  const topRate = best.totalOccurrences > 0 ? topConflicts / best.totalOccurrences : 0
  const secondConflicts = sortedIndividuals[1]?.[1] ?? 0

  if (best.totalConflicts === 0) {
    return { recommendation: 'proceed' }
  }

  if (normalizedConflictRate >= 0.45) {
    return { recommendation: 'suggest_alternatives', blockerUser: topConflicts > 0 ? topName : undefined }
  }

  const dominantBlocker = topConflicts > 0
    && (topConflicts >= Math.max(2, Math.ceil(best.totalConflicts * 0.6)))
    && topRate >= 0.15
    && secondConflicts <= Math.max(1, Math.floor(best.totalConflicts * 0.25))

  if (dominantBlocker) {
    return { recommendation: 'dm_blocker', blockerUser: topName }
  }

  const secondBest = rest[0]
  if (secondBest) {
    const conflictDelta = Math.abs(best.totalConflicts - secondBest.totalConflicts)
    if (conflictDelta <= 2 || (best.totalConflicts > 0 && secondBest.totalConflicts === best.totalConflicts)) {
      return { recommendation: 'present_options', blockerUser: topConflicts > 0 ? topName : undefined }
    }
  }

  if (topRate <= 0.1 && normalizedConflictRate <= 0.15) {
    return { recommendation: 'proceed', blockerUser: topConflicts > 0 ? topName : undefined }
  }

  return { recommendation: 'present_options', blockerUser: topConflicts > 0 ? topName : undefined }
}

const findFreeSlots = tool({
  name: 'findFreeSlots',
  description: 'Find common free time slots for all users in the topic between specified start time and end time. Returns mathematically accurate free slots. Pass the exact user names from the User Directory.',
  parameters: z.object({
    userNames: z.array(z.string()).describe('Array of user names (exact names from User Directory) to find free slots for'),
    startTime: z.string().describe('ISO timestamp for the start of the time range to search for free slots'),
    endTime: z.string().describe('ISO timestamp for the end of the time range to search for free slots'),
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

const findRecurringSlots = tool({
  name: 'findRecurringSlots',
  description: 'Evaluate recurring meeting slots over multiple weeks and return tradeoff summaries plus a high-level recommendation.',
  parameters: z.object({
    userNames: z.array(z.string()).min(1).describe('Exact real names (from the User Directory) to include in the recurrence analysis.'),
    slots: z.array(z.object({
      dayOfWeek: z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']).describe('Day of the week for the recurring slot'),
      time: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM 24-hour format').describe('Local time in HH:MM (24h) for the meeting start'),
      timezone: z.string().describe('IANA timezone for the slot'),
    })).min(1).describe('Candidate recurring slots to evaluate'),
    frequency: z.enum(['WEEKLY', 'BIWEEKLY']).describe('Recurrence cadence to score'),
    durationMinutes: z.number().int().positive().max(8 * 60).describe('Meeting duration in minutes'),
    startDate: z.string().describe('ISO date (YYYY-MM-DD) for the start of the analysis range'),
    endDate: z.string().describe('ISO date (YYYY-MM-DD) for the end of the analysis range'),
    sampleWeeks: z.number().int().positive().max(52).optional().default(12).describe('Number of weeks to sample when scoring conflicts (defaults to 12)'),
  }),
  execute: async (params, runContext?: RunContext<ConversationContext>) => {
    if (!runContext) throw new Error('runContext not provided')

    const { userNames, slots, frequency, durationMinutes, startDate, endDate, sampleWeeks } = params
    const { topic, userMap, message } = runContext.context

    const startPlain = Temporal.PlainDate.from(startDate)
    const requestedEnd = Temporal.PlainDate.from(endDate)
    const limitedEnd = sampleWeeks > 0 ? startPlain.add({ days: sampleWeeks * 7 }) : requestedEnd
    const effectiveEnd = Temporal.PlainDate.compare(limitedEnd, requestedEnd) < 0 ? limitedEnd : requestedEnd
    const analysisEnd = Temporal.PlainDate.compare(effectiveEnd, startPlain) < 0 ? startPlain : effectiveEnd

    const analysisWindowStart = new Date(`${startPlain.toString()}T00:00:00.000Z`)
    const analysisWindowEnd = new Date(`${analysisEnd.toString()}T23:59:59.000Z`)

    const nameToIdMap = new Map<string, string>()
    userMap.forEach((user, id) => {
      if (user.realName) {
        nameToIdMap.set(user.realName, id)
      }
    })

    const missingCalendars: string[] = []
    const unknownUsers: string[] = []
    const calendarMap = new Map<string, (CalendarEvent[] | null)>()

    await Promise.all(userNames.map(async (userName) => {
      const userId = nameToIdMap.get(userName)
      if (!userId) {
        console.warn(`findRecurringSlots: could not match user ${userName}`)
        unknownUsers.push(userName)
        return
      }

      const calendar = await getUserCalendarStructured(userId, topic, analysisWindowStart, analysisWindowEnd)
      if (calendar === null) {
        missingCalendars.push(userName)
        calendarMap.set(userName, null)
        return
      }
      calendarMap.set(userName, calendar)
    }))

    // Ensure all known users appear in the map even if they lacked calendar data
    userNames.forEach((userName) => {
      if (!calendarMap.has(userName) && !unknownUsers.includes(userName)) {
        calendarMap.set(userName, [])
      }
    })

    const scores = scoreRecurringSlots({
      slots,
      durationMinutes,
      frequency,
      startDate,
      endDate: analysisEnd.toString(),
      sampleWeeks,
      userCalendars: calendarMap,
    })

    const sortedScores = scores.slice().sort((a, b) => {
      if (a.totalConflicts !== b.totalConflicts) {
        return a.totalConflicts - b.totalConflicts
      }
      return b.percentAvailable - a.percentAvailable
    })

    const topScores = sortedScores.slice(0, 5)
    const recommendationResult = deriveRecurringRecommendation(sortedScores)
    let recommendation = recommendationResult.recommendation
    const blockerUser = recommendationResult.blockerUser
    if (missingCalendars.length > 0 && recommendation === 'proceed') {
      recommendation = 'present_options'
    }
    const blockerSummaries = sortedScores[0]
      ? summarizeIndividualConflicts(sortedScores[0].perPersonConflicts, sortedScores[0].totalOccurrences)
      : []

    const blockerUserIds = blockerUser ? (() => {
      const blockerId = nameToIdMap.get(blockerUser)
      return blockerId ? [blockerId] : []
    })() : []

    const daySpan = startPlain.until(analysisEnd, { largestUnit: 'days' }).days
    const sampleWeeksUsed = Math.max(1, Math.ceil((daySpan + 1) / 7))

    try {
      await updateTopicState(
        topic,
        {
          recurringMetadata: {
            analyzedRange: {
              startDate,
              endDate: analysisEnd.toString(),
              frequency,
              sampleWeeks: sampleWeeksUsed,
            },
            candidateSlots: topScores,
            blockerUserIds,
            recommendation,
            selectedSlot: null,
            lastAnalyzedAt: new Date().toISOString(),
            missingCalendars,
          },
        },
        message.id,
      )
    } catch (error) {
      console.error('Failed to persist recurring metadata', error)
    }

    return {
      analysisWindow: {
        startDate,
        endDate: analysisEnd.toString(),
        requestedEndDate: endDate,
        sampleWeeksUsed,
      },
      totalSlotsConsidered: sortedScores.length,
      slots: topScores.map((score) => ({
        slot: score.slot,
        durationMinutes: score.durationMinutes,
        totalOccurrences: score.totalOccurrences,
        totalConflicts: score.totalConflicts,
        perPersonConflicts: score.perPersonConflicts,
        percentAvailable: Number(score.percentAvailable.toFixed(2)),
        conflictWeeks: score.conflictWeeks,
        tradeoffSummary: score.tradeoffSummary,
        unknownParticipants: score.unknownParticipants ?? [],
      })),
      missingCalendars,
      unknownUsers,
      recommendation,
      blockerUser: blockerUser ?? null,
      blockerSummaries,
      participantsEvaluated: Array.from(calendarMap.keys()),
    }
  },
})

function describeSlotForPrompt(score: RecurringSlotScore): string {
  const label = getWeekdayLabel(score.slot.dayOfWeek)
  const availability = `${score.percentAvailable.toFixed(1)}% availability`
  const conflictDetails = Object.entries(score.perPersonConflicts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}×${count}`)
  const conflicts = conflictDetails.length > 0
    ? `${score.totalConflicts} conflicts (${conflictDetails.join(', ')})`
    : 'no conflicts detected'
  return `${label} ${score.slot.time} (${score.slot.timezone}) · ${availability}; ${conflicts}. ${score.tradeoffSummary}`
}

function formatRecurringMetadata(metadata?: RecurringMetadata | null): string {
  if (!metadata) return ''

  const details: string[] = []
  if (metadata.analyzedRange) {
    const { startDate, endDate, frequency, sampleWeeks } = metadata.analyzedRange
    const span = sampleWeeks ? `${sampleWeeks} week sample` : 'full requested range'
    details.push(`Last analysis: ${startDate} → ${endDate} (${frequency.toLowerCase()}, ${span}).`)
  }
  if (metadata.recommendation) {
    details.push(`Previous recommendation: ${metadata.recommendation.replace(/_/g, ' ')}.`)
  }
  if (metadata.selectedSlot) {
    const { dayOfWeek, time, timezone } = metadata.selectedSlot
    details.push(`Tentative preferred slot: ${getWeekdayLabel(dayOfWeek)} ${time} (${timezone}).`)
  }
  if (metadata.candidateSlots && metadata.candidateSlots.length > 0) {
    const topLines = metadata.candidateSlots.slice(0, 3).map((score, index) => `  ${index + 1}. ${describeSlotForPrompt(score)}`)
    details.push('Top scored slots:\n' + topLines.join('\n'))
  }
  if (metadata.blockerUserIds && metadata.blockerUserIds.length > 0) {
    details.push(`Named blockers: ${metadata.blockerUserIds.length} participant${metadata.blockerUserIds.length > 1 ? 's' : ''}.`)
  }
  if (metadata.missingCalendars && metadata.missingCalendars.length > 0) {
    details.push(`Still missing calendar data for: ${metadata.missingCalendars.join(', ')}.`)
  }
  if (!details.length) return ''
  return details.join('\n')
}

const updateUserCalendar = tool({
  name: 'updateUserCalendar',
  description: 'Update a user\'s calendar with manual availability overrides. These will be merged with their existing calendar, overwriting any overlapping time periods.',
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
  const mainPrompt = `You are a scheduling assistant who coordinates meetings for small teams.

Core principles
- Always respond when directly addressed. Keep replies short (1-2 sentences) unless you are listing time options.
- Render every time in the requesting user's timezone with the abbreviation in parentheses (e.g., "2:30pm (PDT)"). Mention other timezones when it helps.
- Use calendars and stored context before re-asking for availability. Update the topic summary whenever new constraints or goals are confirmed.

How to work
1. Review the topic summary, participant list, and the recurring analysis snapshot below.
2. Decide whether you need more information or can propose concrete options.
3. Use tools for precise work (calendar math, participant updates, summaries). If information is missing, ask for it directly instead of guessing.

Recurring meetings
- Detect language like "weekly", "biweekly", "every Monday", or "standup".
- Gather cadence details first: frequency (weekly or biweekly), candidate weekday+local time combinations, anchor timezone, meeting duration, and the date window to evaluate (defaults to about 8-12 weeks).
- Run **findRecurringSlots** to score the candidates. Combine its recommendation with judgment, especially when calendars are missing or blockers are flagged.
  - proceed -> share the strongest option with a brief tradeoff summary.
  - dm_blocker -> follow up privately with the blocker before moving forward.
  - present_options -> list the top 2-3 choices and highlight the tradeoffs.
  - suggest_alternatives -> explain why nothing works and suggest next steps (rotate times, adjust cadence, split the group).
- When calendars are missing, ask those people for availability instead of assuming they are free.
- Once everyone agrees on a slot, include a **finalizedEvent** (start, end, summary, and recurrencePattern when relevant) plus a concise confirmation in groupMessage. The platform sends the invite details automatically.

Availability handling
- Record exactly what people share. Do not infer additional busy/free time without confirmation; ask clarifying questions if a window is vague.
- Before pinging someone, confirm they have not already given enough availability in the conversation.

Tools you can call
- **findFreeSlots**: Computes exact intersections for a given roster and date range. Run this before proposing one-off times when calendars exist.
- **findRecurringSlots**: Scores recurring options over the requested window, surfacing blockers and tradeoffs.
- **updateUserNames**: Replace the entire participant list. Use full real names from the directory.
- **updateUserCalendar**: Store explicit availability/busy overrides exactly as stated (busy by default, set free=true for declared availability). Overrides merge with existing data.
- **updateSummary**: Keep the topic summary current as plans evolve.

Response contract
- If you promise to message someone, include that DM in this turn's messagesToUsers. Skip empty acknowledgments.
- Use groupMessage only for updates everyone should see, such as confirmations.
- When you return JSON, match the ConversationRes schema (replyMessage, markTopicInactive, messagesToUsers, groupMessage, finalizedEvent, cancelEvent, reasoning). Keep reasoning concise.
- Use an empty string for replyMessage when no immediate message is needed.
`

  const { topic, userMap, callingUserTimezone } = runContext.context

  const rescheduleAddendum = `

## Rescheduling Behavior (Important)
- If there is exactly ONE scheduled meeting in this topic (see the numbered list under "Current Scheduled Events") and the user says "move it" / "reschedule it" or refers to "the meeting", assume they mean that single meeting. Do not ask which meeting; finalize the new time directly.
- If there are MULTIPLE scheduled meetings and the request is ambiguous, ask a brief clarification referring to the numbered entries (e.g., "[1]" or "[2]") and showing the day/time. If the message clearly references a specific day/time, pick that one directly.
- To reschedule, just include a new finalizedEvent with the requested start/end; the system will update the existing invite.
- When participants agree to cancel the meeting entirely, set cancelEvent: true (and normally omit finalizedEvent) so the existing invite is removed, and clearly notify everyone of the cancellation.
`

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
        scheduledSection = `
Current Scheduled Events (via calendar):
${scheduledDisplay.join('\n')}`
      }
    }
  } catch (error) {
    console.error('Failed to list scheduled events for topic', topic.id, error)
  }

  const recurringMetadataSummary = formatRecurringMetadata(topic.state.recurringMetadata)

  const userMapAndTopicInfo = `
${userMap && userMap.size > 0 ? `User Directory:
${Array.from(userMap.entries())
  .filter(([_userId, user]) => !user.isBot && user.realName)
  .sort((a, b) => (a[1].realName!).localeCompare(b[1].realName!))
  .map(([_userId, user]) => user.realName)
  .join(', ')}

` : ''}Current Topic:
Summary: ${topic.state.summary}
${recurringMetadataSummary ? `Recurring analysis snapshot:
${recurringMetadataSummary}

` : ''}Users involved (with timezones and calendar status):
${await Promise.all(topic.state.userIds.map(async (userId) => {
  const user = userMap.get(userId)
  const userName = user?.realName || 'Unknown User'
  const tz = user?.tz
  const userTzStr = tz ? `${userName} (${getShortTimezoneFromIANA(tz)})` : userName

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

  return mainPrompt + rescheduleAddendum + userMapAndTopicInfo
}


export const schedulingAgent = new ConversationAgent({
  name: 'schedulingAgent',
  model: 'anthropic/claude-sonnet-4',
  modelSettings: {
    maxTokens: 1024,
    temperature: 0.7,
    parallelToolCalls: false, // Only allow one tool call at a time
  },
  tools: [findFreeSlots, findRecurringSlots, updateUserNames, updateUserCalendar, updateSummary],
  outputType: ConversationRes,
  instructions: schedulingInstructions,
})
