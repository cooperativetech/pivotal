import { eq, sql } from 'drizzle-orm'
import { google } from 'googleapis'
// Enable typing for calendar API event shapes where helpful
import type { calendar_v3 } from 'googleapis'
import type { WebClient } from '@slack/web-api'
import { v2beta } from '@google-apps/meet'

import db from './db/engine'
import { userDataTable, slackUserTable } from './db/schema/main'
import type { UserContext, CalendarEvent, TopicUserContext, TopicWithState } from '@shared/api-types'
import { mergeCalendarWithOverrides } from '@shared/utils'
import { processSchedulingActions } from './slack-message-handler'
import { getTopicWithState, updateTopicState } from './utils'
import { getGoogleCalendar, isGoogleCalendarConnected } from './integrations/google'

function getBotCalendarId(): string {
  return process.env.PV_GOOGLE_BOT_CALENDAR_ID || 'primary'
}

const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/meetings.space.created',
  'https://www.googleapis.com/auth/meetings.space.settings',
]

function buildServiceAccountCalendarClient() {
  const clientEmail = process.env.PV_GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.PV_GOOGLE_SERVICE_ACCOUNT_KEY
  const subject = process.env.PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT

  if (!clientEmail || !privateKey || !subject) {
    console.warn('[Calendar] Missing service account credentials (PV_GOOGLE_SERVICE_ACCOUNT_EMAIL / PV_GOOGLE_SERVICE_ACCOUNT_KEY / PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT).')
    return null
  }

  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey

  const jwt = new google.auth.JWT({
    email: clientEmail,
    key: normalizedKey,
    subject,
    scopes: SERVICE_ACCOUNT_SCOPES,
  })

  return google.calendar({ version: 'v3', auth: jwt })
}

function buildServiceAccountJWT() {
  const clientEmail = process.env.PV_GOOGLE_SERVICE_ACCOUNT_EMAIL
  const privateKey = process.env.PV_GOOGLE_SERVICE_ACCOUNT_KEY
  const subject = process.env.PV_GOOGLE_SERVICE_ACCOUNT_SUBJECT

  if (!clientEmail || !privateKey || !subject) {
    console.warn('[Calendar] Missing service account credentials for Meet API')
    return null
  }

  const normalizedKey = privateKey.includes('\\n')
    ? privateKey.replace(/\\n/g, '\n')
    : privateKey

  return new google.auth.JWT({
    email: clientEmail,
    key: normalizedKey,
    subject,
    scopes: SERVICE_ACCOUNT_SCOPES,
  })
}

/**
 * Create a Google Meet space with moderation enabled
 * Returns the space name and meeting URI/code
 */
async function createMeetSpace(): Promise<{ spaceName: string, meetingUri: string, meetingCode: string } | null> {
  try {
    const jwt = buildServiceAccountJWT()
    if (!jwt) {
      console.warn('[Calendar] Could not build JWT client, skipping Meet space creation')
      return null
    }

    await jwt.authorize()
    const accessToken = jwt.credentials.access_token

    if (!accessToken) {
      console.warn('[Calendar] Could not get access token for Meet API')
      return null
    }

    const response = await fetch('https://meet.googleapis.com/v2/spaces', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          accessType: 'OPEN',
          entryPointAccess: 'ALL',
        },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Failed to create Meet space: ${response.status} ${errorText}`)
    }

    const space = await response.json() as {
      name: string
      meetingUri: string
      meetingCode: string
    }

    console.log('[Calendar] Created Meet space:', {
      name: space.name,
      meetingUri: space.meetingUri,
      meetingCode: space.meetingCode,
    })

    return {
      spaceName: space.name,
      meetingUri: space.meetingUri,
      meetingCode: space.meetingCode,
    }
  } catch (error) {
    console.error('[Calendar] Error creating Meet space:', error)
    return null
  }
}

/**
 * Add co-hosts to a Google Meet space using the gRPC client library
 * Returns true if all co-hosts were added successfully
 */
async function addCoHostsToMeetSpace(spaceName: string, emails: string[]): Promise<boolean> {
  try {
    if (emails.length === 0) return true

    const jwt = buildServiceAccountJWT()
    if (!jwt) {
      console.warn('[Calendar] Could not build JWT client, skipping co-host assignment')
      return false
    }

    console.log('[Calendar] Adding co-hosts to space:', spaceName, 'emails:', emails)

    // Create Meet API client with service account auth (v2beta for members API)
    const meetClient = new v2beta.SpacesServiceClient({
      authClient: jwt,
    })

    // Add each email as a co-host
    const results = await Promise.allSettled(
      emails.map(async (email) => {
        return await meetClient.createMember({
          parent: spaceName,
          member: {
            role: 'COHOST',
            user: email,
          },
        })
      }),
    )

    const failures = results.filter((r) => r.status === 'rejected')
    if (failures.length > 0) {
      console.warn(
        `[Calendar] Failed to add ${failures.length}/${emails.length} co-hosts:`,
        failures.map((f) => (f.status === 'rejected' ? String(f.reason) : null)),
      )
    }

    return failures.length === 0
  } catch (error) {
    console.error('[Calendar] Error adding co-hosts to Meet space:', error)
    return false
  }
}

/**
 * Get stored user context
 */
export async function getUserContext(slackUserId: string): Promise<UserContext> {
  const [userData] = await db
    .select()
    .from(userDataTable)
    .where(eq(userDataTable.slackUserId, slackUserId))
    .limit(1)
  return userData?.context || {}
}

/**
 * Update user context with new information learned by the LLM
 * Merges new context with existing context
 */
export async function updateUserContext(slackUserId: string, newContext: UserContext) {
  const existingContext = await getUserContext(slackUserId)
  const mergedContext = { ...existingContext, ...newContext }

  const [userData] = await db
    .insert(userDataTable)
    .values({
      slackUserId,
      context: mergedContext,
    })
    .onConflictDoUpdate({
      target: userDataTable.slackUserId,
      set: {
        context: sql.raw('excluded.context'),
      },
    })
    .returning()

  return userData.context
}

/**
 * Update topic-specific user context
 * Merges new context with existing topic-specific context
 * Returns the updated topic
 */
export async function updateTopicUserContext(topicId: string, slackUserId: string, newContext: TopicUserContext, messageId: string): Promise<TopicWithState> {
  const topic = await getTopicWithState(topicId)

  const existingContext = topic.state.perUserContext[slackUserId] || {}
  const mergedContext = { ...existingContext, ...newContext }

  // Update the record
  const updatedPerUserContext = {
    ...topic.state.perUserContext,
    [slackUserId]: mergedContext,
  }

  const updatedTopic = await updateTopicState(
    topic,
    { perUserContext: updatedPerUserContext },
    messageId,
  )

  return updatedTopic
}

/**
 * Set the calendar prompt suppression flag for a user
 */
export async function setSuppressCalendarPrompt(slackUserId: string, suppress: boolean = true): Promise<void> {
  await updateUserContext(slackUserId, { suppressCalendarPrompt: suppress })
}

/**
 * Check if a user has been prompted for calendar connection in a specific topic
 */
async function hasUserBeenPrompted(topicId: string, userId: string): Promise<boolean> {
  const topic = await getTopicWithState(topicId)
  const userContext = topic.state.perUserContext[userId]
  return !!userContext?.calendarPrompted
}

/**
 * Add a user to the list of users who have been prompted for calendar connection in a topic
 */
export async function addPromptedUser(topicId: string, userId: string, messageId: string): Promise<void> {
  await updateTopicUserContext(topicId, userId, { calendarPrompted: true }, messageId)
}

/**
 * Check if a user should be shown calendar connection buttons
 * Consolidates all the logic for determining when to show calendar prompts
 */
export async function shouldShowCalendarButtons(
  topicId: string,
  userId: string,
): Promise<boolean> {
  const [isCalendarConnected, hasBeenPrompted, userContext] = await Promise.all([
    isGoogleCalendarConnected(userId),
    hasUserBeenPrompted(topicId, userId),
    getUserContext(userId),
  ])
  return !hasBeenPrompted && !isCalendarConnected && !userContext.suppressCalendarPrompt
}

/**
 * Continue scheduling workflow after calendar connection for specific topic
 */
export async function continueSchedulingWorkflow(topicId: string, slackUserId: string, slackClient: WebClient) {
  try {
    const topic = await getTopicWithState(topicId)
    if (!topic.state.isActive) throw new Error(`Topic ${topicId} is not active`)

    // Open a DM with the user so follow-up lands in their inbox
    const dm = await slackClient.conversations.open({ users: slackUserId })
    const dmChannelId = dm.ok && dm.channel?.id ? dm.channel.id : 'synthetic'

    const syntheticSlackMessage = {
      id: `synthetic-${Date.now()}`,
      topicId,
      channelId: dmChannelId,
      userId: slackUserId,
      text: 'Google Calendar connected',
      timestamp: new Date(),
      rawTs: (Date.now() / 1000).toString(),
      threadTs: null,
      raw: {},
      autoMessageId: null,
    }

    await processSchedulingActions(topicId, syntheticSlackMessage, slackClient)
  } catch (error) {
    console.error(`Error continuing scheduling workflow for user ${slackUserId}:`, error)
  }
}

/**
 * Create a Google Calendar event from the bot account and return links.
 * Uses env-provided bot refresh token. Optionally suppresses emails (Slack-only mode).
 */
export interface CalendarActionResult {
  htmlLink?: string
  meetLink?: string
  eventId?: string
  calendarId?: string
  event?: calendar_v3.Schema$Event
}

export async function createCalendarInviteFromBot(
  topic: TopicWithState,
  finalizedEvent: { start: string, end: string, summary?: string | null },
): Promise<CalendarActionResult | null> {
  try {
    const calendar = buildServiceAccountCalendarClient()
    if (!calendar) {
      console.warn('Bot calendar not configured: service account credentials are missing')
      return null
    }

    // Load attendee emails from Slack users in the topic (exclude bots / missing emails)
    const attendees: { email: string }[] = []
    const users = await db.select().from(slackUserTable)
    for (const user of users) {
      if (topic.state.userIds.includes(user.id) && user.email) attendees.push({ email: user.email })
    }

    const requestId = `pivotal-${topic.id}-${Date.now()}`
    const summary = finalizedEvent.summary || topic.state.summary || 'Meeting'

    // Create Meet space first if we have attendees (so we can add co-hosts)
    let meetSpace: { spaceName: string, meetingUri: string, meetingCode: string } | null = null
    if (attendees.length > 0) {
      meetSpace = await createMeetSpace()
      if (meetSpace) {
        // Add all attendees as co-hosts
        const attendeeEmails = attendees.map((a) => a.email)
        await addCoHostsToMeetSpace(meetSpace.spaceName, attendeeEmails)
      }
    }

    // Create calendar event, linking to the Meet space if we created one
    const requestBody: calendar_v3.Schema$Event = {
      summary,
      start: { dateTime: new Date(finalizedEvent.start).toISOString() },
      end: { dateTime: new Date(finalizedEvent.end).toISOString() },
      attendees,
      extendedProperties: {
        private: {
          pv_topic_id: topic.id,
          pv_request_id: requestId,
        },
      },
    }

    // If we created a Meet space, link it to the calendar event
    if (meetSpace) {
      requestBody.conferenceData = {
        conferenceId: meetSpace.meetingCode,
        entryPoints: [
          {
            entryPointType: 'video',
            uri: meetSpace.meetingUri,
            label: meetSpace.meetingUri,
          },
        ],
        conferenceSolution: {
          key: { type: 'hangoutsMeet' },
        },
      }
    } else {
      // Fallback to Calendar-created Meet if space creation failed
      requestBody.conferenceData = {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      }
    }

    const insertRes = await calendar.events.insert({
      calendarId: getBotCalendarId(),
      requestBody,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
    })

    const event = insertRes.data
    let meetLink: string | undefined
    const entryPoints = event.conferenceData?.entryPoints
    if (entryPoints && entryPoints.length > 0) {
      const meeting = entryPoints.find((e) => e.entryPointType === 'video') || entryPoints[0]
      meetLink = meeting.uri || meeting.label || undefined
    }

    return {
      htmlLink: event.htmlLink || undefined,
      meetLink,
      eventId: event.id || undefined,
      calendarId: getBotCalendarId(),
      event,
    }
  } catch (error) {
    console.error('Error creating calendar invite from bot:', error)
    return null
  }
}

// Rescheduling and event tracking helpers

/**
 * Find the most relevant Google Calendar event for a topic using extendedProperties tags.
 */
async function findTaggedEventForTopic(topicId: string): Promise<calendar_v3.Schema$Event | null> {
  const calendar = buildServiceAccountCalendarClient()
  if (!calendar) return null

  const res = await calendar.events.list({
    calendarId: getBotCalendarId(),
    privateExtendedProperty: [`pv_topic_id=${topicId}`],
    showDeleted: false,
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
    timeMax: new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString(),
  })

  const items: calendar_v3.Schema$Event[] = res.data.items ?? []
  if (items.length === 0) return null

  const now = new Date()
  type Listed = { e: calendar_v3.Schema$Event; start: Date; end: Date; updated: Date }
  const upcoming: Listed[] = items
    .map((e): Listed => ({
      e,
      start: new Date(e.start?.dateTime || e.start?.date || 0),
      end: new Date(e.end?.dateTime || e.end?.date || 0),
      updated: e.updated ? new Date(e.updated) : new Date(0),
    }))
    .filter((x) => x.end >= now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  if (upcoming.length > 0) return upcoming[0].e

  items.sort((a, b) => new Date(b.updated ?? 0).getTime() - new Date(a.updated ?? 0).getTime())
  return items[0]
}

export async function listBotScheduledEvents(topicId: string): Promise<CalendarEvent[]> {
  try {
    const calendar = buildServiceAccountCalendarClient()
    if (!calendar) return []

    const res = await calendar.events.list({
      calendarId: getBotCalendarId(),
      privateExtendedProperty: [`pv_topic_id=${topicId}`],
      showDeleted: false,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
      timeMin: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(),
      timeMax: new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString(),
    })

    const items = res.data.items ?? []
    const events: CalendarEvent[] = []

    for (const item of items) {
      const start = item.start?.dateTime
      const end = item.end?.dateTime
      if (!start || !end) continue

      const participantEmails = (item.attendees ?? [])
        .map((attendee) => attendee.email)
        .filter((email): email is string => Boolean(email))

      const calendarEvent: CalendarEvent = {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        summary: item.summary || 'Meeting',
        free: false,
      }

      if (participantEmails.length > 0) {
        calendarEvent.participantEmails = participantEmails
      }

      events.push(calendarEvent)
    }

    return events
  } catch (error) {
    console.error('Error listing bot scheduled events:', error)
    return []
  }
}

/**
 * Attempt to reschedule a previously created (tagged) event for this topic. Returns true if updated.
 */
export async function tryRescheduleTaggedEvent(
  topicId: string,
  newStartISO: string,
  newEndISO: string,
): Promise<CalendarActionResult & { success: boolean }>{
  try {
    const calendar = buildServiceAccountCalendarClient()
    if (!calendar) return { success: false }

    const existing = await findTaggedEventForTopic(topicId)
    if (!existing?.id) return { success: false }

    const patchRes = await calendar.events.patch({
      calendarId: getBotCalendarId(),
      eventId: existing.id,
      requestBody: {
        start: { dateTime: new Date(newStartISO).toISOString() },
        end: { dateTime: new Date(newEndISO).toISOString() },
      },
      sendUpdates: 'all',
    })

    const updated = patchRes.data
    const entryPoints = updated.conferenceData?.entryPoints || existing.conferenceData?.entryPoints
    const meeting = entryPoints?.find((e) => e.entryPointType === 'video') || entryPoints?.[0]
    const meetLink = meeting?.uri || meeting?.label || undefined

    return {
      success: true,
      meetLink,
      htmlLink: updated.htmlLink || existing.htmlLink || undefined,
      event: updated ?? existing,
      eventId: updated.id || existing.id,
      calendarId: getBotCalendarId(),
    }
  } catch (err) {
    console.error('Error rescheduling calendar event:', err)
    return { success: false }
  }
}

/**
 * Delete the calendar event previously associated with this topic, if any.
 */
export async function deleteTaggedEvent(topicId: string): Promise<boolean> {
  try {
    const calendar = buildServiceAccountCalendarClient()
    if (!calendar) return false

    const existing = await findTaggedEventForTopic(topicId)
    if (!existing?.id) return false

    await calendar.events.delete({
      calendarId: getBotCalendarId(),
      eventId: existing.id,
      sendUpdates: 'all',
    })

    return true
  } catch (err) {
    console.error('Error deleting calendar event:', err)
    return false
  }
}

/**
 * Helper function to check if two calendar events overlap
 */
export function eventsOverlap(event1: CalendarEvent, event2: CalendarEvent): boolean {
  const start1 = new Date(event1.start)
  const end1 = new Date(event1.end)
  const start2 = new Date(event2.start)
  const end2 = new Date(event2.end)
  return start1 < end2 && end1 > start2
}

/**
 * Get structured calendar data from userContext and topic.perUserContext
 * Returns calendar events in structured format
 */
export async function getUserCalendarStructured(slackUserId: string, topic: TopicWithState, startTime: Date, endTime: Date): Promise<CalendarEvent[] | null> {
  try {
    const calendar = await getGoogleCalendar(slackUserId, startTime, endTime)
    const topicContext = topic.state.perUserContext[slackUserId]

    // If there's no calendar info for the user, return null to indicate this
    if (calendar === null && !topicContext?.calendarManualOverrides) {
      return null
    }

    let calEvents: CalendarEvent[] =  []

    // Filter events to only include those that overlap with the requested time range
    if (calendar !== null) {
      calEvents = calendar.filter((event) => {
        const eventStart = new Date(event.start)
        const eventEnd = new Date(event.end)
        return eventStart < endTime && eventEnd > startTime
      })
    }

    // Merge with topic-specific manual overrides if they exist
    if (topicContext?.calendarManualOverrides) {
      // Filter overrides to only include those that overlap with the requested time range
      const filteredOverrides = topicContext.calendarManualOverrides.filter((override) => {
        const overrideStart = new Date(override.start)
        const overrideEnd = new Date(override.end)
        return overrideStart < endTime && overrideEnd > startTime
      })

      calEvents = mergeCalendarWithOverrides(calEvents, filteredOverrides)
    }

    return calEvents
  } catch (error) {
    console.error(`Error getting structured calendar for user ${slackUserId}:`, error)
  }

  return null
}
