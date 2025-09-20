import { eq, sql } from 'drizzle-orm'
import { google } from 'googleapis'
// Enable typing for calendar API event shapes where helpful
import type { calendar_v3 } from 'googleapis'
import type { Context } from 'hono'
import type { WebClient } from '@slack/web-api'
import { z } from 'zod'

import db from './db/engine'
import { userDataTable, slackUserTable } from './db/schema/main'
import type { UserContext, CalendarEvent, CalendarRangeLastFetched, TopicUserContext, TopicWithState } from '@shared/api-types'
import { mergeCalendarWithOverrides } from '@shared/utils'
import { genFakeCalendar } from './agents'
import { processSchedulingActions } from './slack-message-handler'
import { getTopicWithState, updateTopicState } from './utils'
import { baseURL } from './auth'

function getBotCalendarId(): string {
  return process.env.PV_GOOGLE_BOT_CALENDAR_ID || 'primary'
}

const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
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

export interface GoogleAuthTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}

const GOOGLE_AUTH_REDIRECT_URI = `${baseURL}/auth/google/callback`

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
 * Check if a user has their calendar connected
 */
export async function isCalendarConnected(slackUserId: string): Promise<boolean> {
  const context = await getUserContext(slackUserId)
  return !!context.googleAccessToken
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
  // Fetch user context and topic data in parallel for efficiency
  const [userContext, hasBeenPrompted] = await Promise.all([
    getUserContext(userId),
    hasUserBeenPrompted(topicId, userId),
  ])

  // Only show buttons if: not already prompted, no calendar, and hasn't suppressed prompts
  return !hasBeenPrompted &&
         !userContext.googleAccessToken &&
         !userContext.suppressCalendarPrompt
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

export async function clearUserGoogleTokens(slackUserId: string): Promise<void> {
  await updateUserContext(slackUserId, {
    googleAccessToken: undefined,
    googleRefreshToken: undefined,
    googleTokenExpiryDate: undefined,
    googleConnectedAt: undefined,
    calendar: undefined,
    calendarRangeLastFetched: undefined,
  })
}

/**
 * Generate Google OAuth URL for a specific Slack user and topic
 * Includes state parameter to link back to the Slack user and topic after auth
 */
export function generateGoogleAuthUrl(
  topicId: string,
  slackUserId: string,
  origin: 'slack' | 'webapp' = 'slack',
): string {
  const scope = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: process.env.PV_GOOGLE_CLIENT_ID!,
    redirect_uri: GOOGLE_AUTH_REDIRECT_URI,
    response_type: 'code',
    scope,
    state: `origin:${origin}:slack:${slackUserId}:topic:${topicId}`,
    access_type: 'offline',
    prompt: 'consent', // Force consent to ensure we get refresh token
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export const GoogleAuthCallbackReq = z.strictObject({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
  scope: z.string(),
})
export type GoogleAuthCallbackReq = z.infer<typeof GoogleAuthCallbackReq>

/**
 * Generate OAuth URL for bot authorization (one-time admin step).
 */
export async function handleGoogleAuthCallback(
  c: Context,
  queryParams: GoogleAuthCallbackReq,
  slackClient: WebClient,
): Promise<Response> {
    const { code, state, error, error_description } = queryParams

    if (error || !code) {
      console.error(`OAuth error: ${error} | ${error_description}`)
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>Error: ${error} | ${error_description}</p>
            <p>You can close this window and try again in Slack.</p>
          </body>
        </html>
      `)
    }

    try {
      const { origin } = await fetchAndStoreGoogleAuthTokens(code, state, slackClient)

      if (origin === 'webapp') {
        const redirectTarget = `${baseURL}/`
        return c.html(`
          <html>
            <head>
              <meta http-equiv="refresh" content="1;url=${redirectTarget}">
            </head>
            <body>
              <h2>Calendar Connected Successfully!</h2>
              <p>Your Google Calendar has been connected to the scheduling bot.</p>
              <p>You will be redirected shortly. If not, <a href="${redirectTarget}">click here</a>.</p>
              <script>
                setTimeout(function () {
                  if (window.location.href !== '${redirectTarget}') {
                    window.location.replace('${redirectTarget}')
                  }
                }, 500)
              </script>
            </body>
          </html>
        `)
      }

      return c.html(`
        <html>
          <body>
            <h2>Calendar Connected Successfully!</h2>
            <p>Your Google Calendar has been connected to the scheduling bot.</p>
            <p>You can close this window and return to Slack.</p>
          </body>
        </html>
      `)

    } catch (tokenError) {
      console.error('Error processing OAuth callback:', tokenError)
      return c.html(`
        <html>
          <body>
            <h2>Calendar Connection Failed</h2>
            <p>There was an error connecting your calendar. Please try again.</p>
          </body>
        </html>
      `)
    }
}

/**
 * Exchange OAuth authorization code for access and refresh tokens, and store in user context
 */
function parseOAuthState(state: string): { origin: 'slack' | 'webapp', slackUserId: string, topicId: string } {
  const parts = state.split(':')
  if (parts.length % 2 !== 0) {
    throw new Error(`Invalid state parameter: ${state}`)
  }
  let origin: 'slack' | 'webapp' = 'slack'
  let slackUserId: string | null = null
  let topicId: string | null = null

  for (let i = 0; i < parts.length; i += 2) {
    const key = parts[i]
    const value = parts[i + 1]
    if (!value) {
      throw new Error(`Invalid state parameter: ${state}`)
    }
    if (key === 'origin') {
      if (value === 'slack' || value === 'webapp') {
        origin = value
      } else {
        throw new Error(`Unknown origin in state parameter: ${state}`)
      }
    } else if (key === 'slack') {
      slackUserId = value
    } else if (key === 'topic') {
      topicId = value
    }
  }

  if (!slackUserId || !topicId) {
    throw new Error(`Invalid state parameter: ${state}`)
  }

  return { origin, slackUserId, topicId }
}

export async function fetchAndStoreGoogleAuthTokens(
  code: string,
  state: string,
  slackClient: WebClient,
): Promise<{ origin: 'slack' | 'webapp', slackUserId: string, topicId: string }> {
    const { origin, slackUserId, topicId } = parseOAuthState(state)

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: process.env.PV_GOOGLE_CLIENT_ID!,
      client_secret: process.env.PV_GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_AUTH_REDIRECT_URI,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange code for tokens: ${error}`)
  }
  const tokens = await response.json() as GoogleAuthTokenResponse

  // Give a 5 second buffer for refreshing auth token
  const expiryDate = Date.now() + (tokens.expires_in - 5) * 1000

  await updateUserContext(slackUserId, {
    googleAccessToken: tokens.access_token,
    googleRefreshToken: tokens.refresh_token,
    googleTokenExpiryDate: expiryDate,
    googleConnectedAt: Date.now(),
    suppressCalendarPrompt: false,
  })

  // Update the original DM (if we stored a pointer) to show success and remove buttons
  try {
    const topic = await getTopicWithState(topicId)
    const pointer = topic.state.perUserContext[slackUserId]?.calendarPromptMessage
    if (pointer?.channelId && pointer?.ts) {
      await slackClient.chat.update({
        channel: pointer.channelId,
        ts: pointer.ts,
        text: '✅ Calendar connected.',
        blocks: [],
      })
    }
  } catch (e) {
    console.warn('Failed to update calendar prompt message after OAuth:', e)
  }

  // Continue scheduling workflow after successful token storage
  await continueSchedulingWorkflow(topicId, slackUserId, slackClient)

  return { origin, slackUserId, topicId }
}

/**
 * Create a Google Calendar event from the bot account and return links.
 * Uses env-provided bot refresh token. Optionally suppresses emails (Slack-only mode).
 */
export async function createCalendarInviteFromBot(
  topic: TopicWithState,
  finalizedEvent: { start: string, end: string, summary?: string | null },
): Promise<{ htmlLink?: string, meetLink?: string, eventId?: string, calendarId?: string } | null> {
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

    const insertRes = await calendar.events.insert({
      calendarId: getBotCalendarId(),
      requestBody: {
        summary,
        start: { dateTime: new Date(finalizedEvent.start).toISOString() },
        end: { dateTime: new Date(finalizedEvent.end).toISOString() },
        attendees,
        // Tag event so we can recover it later by topic id
        extendedProperties: {
          private: {
            pv_topic_id: topic.id,
            pv_request_id: requestId,
          },
        },
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
      conferenceDataVersion: 1,
      // Always email calendar invites to attendees
      sendUpdates: 'all',
    })

    const event = insertRes.data
    let meetLink: string | undefined
    const entryPoints = event.conferenceData?.entryPoints
    if (entryPoints && entryPoints.length > 0) {
      const meeting = entryPoints.find((e) => e.entryPointType === 'video') || entryPoints[0]
      meetLink = meeting.uri || meeting.label || undefined
    }

    return { htmlLink: event.htmlLink || undefined, meetLink, eventId: event.id || undefined, calendarId: getBotCalendarId() }
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
): Promise<{ success: boolean, meetLink?: string, htmlLink?: string }>{
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
    const entryPoints = updated.conferenceData?.entryPoints
    const meeting = entryPoints?.find((e) => e.entryPointType === 'video') || entryPoints?.[0]
    const meetLink = meeting?.uri || meeting?.label || undefined

    return { success: true, meetLink, htmlLink: updated.htmlLink || undefined }
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
 * Fetch calendar events for a user and store in user context
 * This caches calendar data for the LLM to use during scheduling
 */
export async function fetchAndStoreUserCalendar(slackUserId: string, startTime: Date, endTime: Date): Promise<UserContext> {
  try {
    const userContext = await getUserContext(slackUserId)

    if (!userContext.googleAccessToken) {
      throw new Error(`No google auth token found for user ${slackUserId}`)
    }

    // Generate fake calendars if we're testing / evaluating
    if (userContext.googleAccessToken === 'fake-token-for-eval') {
      return genAndStoreFakeUserCalendar(slackUserId, startTime, endTime)
    }

    // Create OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      process.env.PV_GOOGLE_CLIENT_ID,
      process.env.PV_GOOGLE_CLIENT_SECRET,
      GOOGLE_AUTH_REDIRECT_URI,
    )

    oauth2Client.setCredentials({
      access_token: userContext.googleAccessToken,
      refresh_token: userContext.googleRefreshToken,
      expiry_date: userContext.googleTokenExpiryDate,
    })

    // Create calendar client
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // Fetch events
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    })

    if (!response.data.items) {
      console.error(`No calendar events found for user ${slackUserId}`)
      return {}
    }

    // Convert to structured format for storage
    const calendarEvents: CalendarEvent[] = []

    for (const event of response.data.items) {
      if (!event.start || !event.end) continue

      // Handle both dateTime (specific time) and date (all-day) events
      const startTime = event.start.dateTime || event.start.date
      const endTime = event.end.dateTime || event.end.date

      if (!startTime || !endTime) continue

      // Skip all-day events for now
      if (event.start.dateTime && event.end.dateTime) {
        // Extract participant emails from attendees
        const participantEmails: string[] = []
        if (event.attendees) {
          for (const attendee of event.attendees) {
            if (attendee.email) {
              participantEmails.push(attendee.email)
            }
          }
        }

        const calendarEvent: CalendarEvent = {
          start: new Date(startTime).toISOString(),
          end: new Date(endTime).toISOString(),
          summary: event.summary || 'Busy',
        }

        // Only add participants if there are any
        if (participantEmails.length > 0) {
          calendarEvent.participantEmails = participantEmails
        }

        calendarEvents.push(calendarEvent)
      }
    }

    // Update the fetch range tracking
    const updatedRangeLastFetched: CalendarRangeLastFetched = {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      fetchedAt: new Date().toISOString(),
    }

    // Store structured calendar data
    const calendarData = {
      calendar: calendarEvents,  // Store as structured array
      calendarRangeLastFetched: updatedRangeLastFetched,
    }

    // Update google auth credentials in case they were refreshed
    const googleAuthData = (
      oauth2Client.credentials.access_token
      ? {
        googleAccessToken: oauth2Client.credentials.access_token,
        googleTokenExpiryDate: oauth2Client.credentials.expiry_date || undefined,
      } : {}
    )

    const newContext = await updateUserContext(slackUserId, { ...calendarData, ...googleAuthData })
    console.log(`Stored ${calendarEvents.length} calendar events for user ${slackUserId}`)

    return newContext

  } catch (error) {
    console.error(`Error fetching calendar for user ${slackUserId}:`, error)

    // Check for invalid_grant error (expired or revoked tokens)
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (errorMessage.includes('invalid_grant')) {
      console.warn(`Invalid grant detected for user ${slackUserId}, clearing Google auth tokens`)

      // Clear the invalid tokens
      await updateUserContext(slackUserId, {
        googleAccessToken: undefined,
        googleRefreshToken: undefined,
        googleTokenExpiryDate: undefined,
      })
    }

    return {}
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
    let context = await getUserContext(slackUserId)

    // Check if the requested range is within the last fetched range, and was fetched within the last 15 minutes
    const bufferTime = 15 * 60 * 1000
    const needsFetch = !context.calendarRangeLastFetched ||
      new Date(context.calendarRangeLastFetched.startTime) > startTime ||
      new Date(context.calendarRangeLastFetched.endTime) < endTime ||
      (Date.now() - new Date(context.calendarRangeLastFetched.fetchedAt).getTime()) > bufferTime

    if (needsFetch && context.googleAccessToken) {
      context = await fetchAndStoreUserCalendar(slackUserId, startTime, endTime)
    }

    const topicContext = topic.state.perUserContext[slackUserId]

    // If there's no calendar info for the user, return null to indicate this
    if (!context.calendar && !topicContext?.calendarManualOverrides) {
      return null
    }

    let calEvents: CalendarEvent[] =  []

    // Filter events to only include those that overlap with the requested time range
    if (context.calendar) {
      calEvents = context.calendar.filter((event) => {
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

/**
 * Generate and store fake calendar events for a user
 * Used for testing and development when real calendar data isn't available
 */
export async function genAndStoreFakeUserCalendar(
  slackUserId: string,
  startTime: Date,
  endTime: Date,
): Promise<UserContext> {
  try {
    const currentContext = await getUserContext(slackUserId)

    // Get all existing calendar events
    const existingEvents = currentContext.calendar || []

    // Check if this range has already been fetched
    if (currentContext.calendarRangeLastFetched &&
        new Date(currentContext.calendarRangeLastFetched.startTime) <= startTime &&
        new Date(currentContext.calendarRangeLastFetched.endTime) >= endTime) {
      // Range already fetched, just update the fetch timestamp
      const updatedRangeLastFetched: CalendarRangeLastFetched = {
        startTime: currentContext.calendarRangeLastFetched.startTime,
        endTime: currentContext.calendarRangeLastFetched.endTime,
        fetchedAt: new Date().toISOString(),
      }

      const calendarData = {
        calendarRangeLastFetched: updatedRangeLastFetched,
      }

      const newContext = await updateUserContext(slackUserId, calendarData)
      console.log(`Range already fetched for user ${slackUserId}, updated timestamp only`)
      return newContext
    }

    // Range not fetched, generate fake events
    // Get user's timezone from Slack
    const [slackUser] = await db
      .select()
      .from(slackUserTable)
      .where(eq(slackUserTable.id, slackUserId))
      .limit(1)

    const generatedEvents = await genFakeCalendar(
      slackUser?.tz || 'UTC',
      startTime,
      endTime,
    )

    // Filter generated events to exclude any that overlap with existing events
    const nonConflictingEvents = generatedEvents.filter((genEvent) => {
      return !existingEvents.some((existingEvent) => eventsOverlap(genEvent, existingEvent))
    })

    // Combine existing events with new non-conflicting events
    const allEvents = [...existingEvents, ...nonConflictingEvents]

    // Sort events by start time
    allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    // Update the fetch range tracking for fake data
    const updatedRangeLastFetched: CalendarRangeLastFetched = {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      fetchedAt: new Date().toISOString(),
    }

    // Store the combined calendar data
    const calendarData = {
      calendar: allEvents,
      calendarRangeLastFetched: updatedRangeLastFetched,
    }

    const newContext = await updateUserContext(slackUserId, calendarData)
    console.log(`Stored ${allEvents.length} total calendar events for user ${slackUserId} (${existingEvents.length} existing, ${nonConflictingEvents.length} new non-conflicting)`)

    return newContext
  } catch (error) {
    console.error(`Error generating fake calendar for user ${slackUserId}:`, error)
    return {}
  }
}
