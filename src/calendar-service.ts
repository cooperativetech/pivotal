import { eq, sql } from 'drizzle-orm'
import { google } from 'googleapis'
// Enable typing for calendar API event shapes where helpful
import type { calendar_v3, drive_v3 } from 'googleapis'
import type { Context } from 'hono'
import type { WebClient } from '@slack/web-api'
import { z } from 'zod'
import { CronJob } from 'cron'

import db from './db/engine'
import { userDataTable, slackUserTable } from './db/schema/main'
import type { UserContext, CalendarEvent, CalendarRangeLastFetched, TopicUserContext, TopicWithState } from '@shared/api-types'
import { mergeCalendarWithOverrides } from '@shared/utils'
import { genFakeCalendar } from './agents'
import { processSchedulingActions } from './slack-message-handler'
import { getTopicWithState, updateTopicState } from './utils'
import { getTopics } from './utils'

// Note: If PV_INVITES_SENDER === 'bot', we never prompt users to connect calendars.

function getBotCalendarId(): string {
  return process.env.PV_GOOGLE_BOT_CALENDAR_ID || 'primary'
}

function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.PV_GOOGLE_CLIENT_ID,
    process.env.PV_GOOGLE_CLIENT_SECRET,
    GOOGLE_AUTH_REDIRECT_URI,
  )
}

export interface GoogleAuthTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}

// Base URL for OAuth redirect. In local usage, leave PV_BASE_URL unset to default to localhost.
const API_BASE_URL = process.env.PV_BASE_URL || 'http://localhost:3001'
const GOOGLE_AUTH_REDIRECT_URI = `${API_BASE_URL}/auth/google/callback`

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
  // In bot-sender mode, never prompt users to connect calendars
  if (process.env.PV_INVITES_SENDER === 'bot') {
    return false
  }
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

/**
 * Generate Google OAuth URL for a specific Slack user and topic
 * Includes state parameter to link back to the Slack user and topic after auth
 */
export function generateGoogleAuthUrl(topicId: string, slackUserId: string): string {
  const scope = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.events',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: process.env.PV_GOOGLE_CLIENT_ID!,
    redirect_uri: GOOGLE_AUTH_REDIRECT_URI,
    response_type: 'code',
    scope,
    state: `slack:${slackUserId}:topic:${topicId}`,
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
export function generateBotAuthUrl(): string {
  const scope = [
    // Create and manage events for bot-owned calendar
    'https://www.googleapis.com/auth/calendar.events',
    // Read Drive file metadata (to locate transcript/summary Docs)
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    // Read Google Docs content (optional for snippet extraction)
    'https://www.googleapis.com/auth/documents.readonly',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: process.env.PV_GOOGLE_CLIENT_ID!,
    redirect_uri: GOOGLE_AUTH_REDIRECT_URI,
    response_type: 'code',
    scope,
    state: 'bot',
    access_type: 'offline',
    prompt: 'consent',
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

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
      // Support both user-auth (for availability) and bot-auth (organizer) flows
      if (state === 'bot') {
        const tokens = await exchangeGoogleAuthCodeForTokens(code)
        // Show the refresh token so operator can set PV_GOOGLE_BOT_REFRESH_TOKEN
        const refresh = tokens.refresh_token || ''
        return c.html(`
          <html>
            <body>
              <h2>Bot Calendar Authorized</h2>
              <p>Copy this refresh token into your environment as PV_GOOGLE_BOT_REFRESH_TOKEN:</p>
              <pre style="white-space: pre-wrap; word-wrap: break-word; padding: 12px; background: #f5f5f5; border: 1px solid #ddd;">${refresh}</pre>
              <p>Then restart the app. No user calendars will be used for sending invites.</p>
            </body>
          </html>
        `)
      }

      await fetchAndStoreGoogleAuthTokens(code, state, slackClient)

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
export async function fetchAndStoreGoogleAuthTokens(code: string, state: string, slackClient: WebClient): Promise<void> {
    // Parse state to get Slack user and topic info: "slack:U123ABC:topic:uuid"
    const [prefix, slackUserId, topicPrefix, topicId] = state.split(':')

    if (prefix !== 'slack' || !slackUserId || topicPrefix !== 'topic' || !topicId) {
      throw new Error(`Invalid state parameter: ${state}`)
    }

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
}

/**
 * Exchange OAuth authorization code for tokens (no storage).
 */
async function exchangeGoogleAuthCodeForTokens(code: string): Promise<GoogleAuthTokenResponse> {
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
  return await response.json() as GoogleAuthTokenResponse
}

/**
 * Create a Google Calendar event from the organizer (leader) and send invites to all users in the topic.
 * Includes a Google Meet link. Returns the created event's HTML link and meeting link (if any).
 */
export async function createCalendarInviteFromLeader(
  topic: TopicWithState,
  organizerSlackUserId: string,
  finalizedEvent: { start: string, end: string, title?: string | null, location?: string | null, description?: string | null },
): Promise<{ htmlLink?: string, meetLink?: string } | null> {
  try {
    // Validate organizer has Google auth
    const organizerContext = await getUserContext(organizerSlackUserId)
    if (!organizerContext.googleAccessToken || organizerContext.googleAccessToken === 'fake-token-for-eval') {
      console.warn(`Organizer ${organizerSlackUserId} does not have a valid Google auth token; cannot create calendar invite.`)
      return null
    }

    // Build OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      process.env.PV_GOOGLE_CLIENT_ID,
      process.env.PV_GOOGLE_CLIENT_SECRET,
      GOOGLE_AUTH_REDIRECT_URI,
    )
    oauth2Client.setCredentials({
      access_token: organizerContext.googleAccessToken,
      refresh_token: organizerContext.googleRefreshToken,
      expiry_date: organizerContext.googleTokenExpiryDate,
    })

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // Load attendee emails from Slack users in the topic (exclude bots / missing emails)
    const attendees: { email: string }[] = []
    const users = await db
      .select()
      .from(slackUserTable)
    for (const user of users) {
      if (topic.state.userIds.includes(user.id) && user.email) {
        attendees.push({ email: user.email })
      }
    }

    // Ensure organizer is included as attendee (helps ensure they are on event if API treats creator separately)
    const organizer = (await db.select().from(slackUserTable).where(eq(slackUserTable.id, organizerSlackUserId))).at(0)
    if (organizer?.email && !attendees.some((a) => a.email.toLowerCase() === organizer.email!.toLowerCase())) {
      attendees.push({ email: organizer.email })
    }

    const requestId = `pivotal-${topic.id}-${Date.now()}`
    const summary = finalizedEvent.title || topic.state.summary || 'Meeting'
    const description = finalizedEvent.description || undefined

    // Prepare event insert request
    const insertRes = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: new Date(finalizedEvent.start).toISOString() },
        end: { dateTime: new Date(finalizedEvent.end).toISOString() },
        location: finalizedEvent.location || undefined,
        attendees,
        conferenceData: {
          createRequest: {
            requestId,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
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

    return { htmlLink: event.htmlLink || undefined, meetLink }
  } catch (error) {
    console.error('Error creating calendar invite:', error)
    return null
  }
}

/**
 * Create a Google Calendar event from the bot account and return links.
 * Uses env-provided bot refresh token. Optionally suppresses emails (Slack-only mode).
 */
export async function createCalendarInviteFromBot(
  topic: TopicWithState,
  finalizedEvent: { start: string, end: string, title?: string | null, location?: string | null, description?: string | null },
): Promise<{ htmlLink?: string, meetLink?: string, eventId?: string, calendarId?: string, conferenceId?: string } | null> {
  try {
    if (!process.env.PV_GOOGLE_BOT_REFRESH_TOKEN) {
      console.warn('Bot calendar not configured: PV_GOOGLE_BOT_REFRESH_TOKEN is missing')
      return null
    }

    const oauth2Client = buildOAuthClient()
    oauth2Client.setCredentials({
      refresh_token: process.env.PV_GOOGLE_BOT_REFRESH_TOKEN,
    })

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    // Load attendee emails from Slack users in the topic (exclude bots / missing emails)
    const attendees: { email: string }[] = []
    const users = await db.select().from(slackUserTable)
    for (const user of users) {
      if (topic.state.userIds.includes(user.id) && user.email) attendees.push({ email: user.email })
    }

    const requestId = `pivotal-${topic.id}-${Date.now()}`
    const summary = finalizedEvent.title || topic.state.summary || 'Meeting'
    const description = finalizedEvent.description || undefined

    const insertRes = await calendar.events.insert({
      calendarId: getBotCalendarId(),
      requestBody: {
        summary,
        description,
        start: { dateTime: new Date(finalizedEvent.start).toISOString() },
        end: { dateTime: new Date(finalizedEvent.end).toISOString() },
        location: finalizedEvent.location || undefined,
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

    return {
      htmlLink: event.htmlLink || undefined,
      meetLink,
      eventId: event.id || undefined,
      calendarId: getBotCalendarId(),
      conferenceId: event.conferenceData?.conferenceId || undefined,
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
  if (!process.env.PV_GOOGLE_BOT_REFRESH_TOKEN) return null

  const oauth2Client = buildOAuthClient()
  oauth2Client.setCredentials({ refresh_token: process.env.PV_GOOGLE_BOT_REFRESH_TOKEN })
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

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

/** Upsert a scheduled event in the topic's perUserContext[botUserId].scheduledEvents */
export async function upsertTopicScheduledEvent(
  topic: TopicWithState,
  newEvent: {
    calendarId: string,
    eventId?: string | null,
    iCalUID?: string | null,
    start?: string | null,
    end?: string | null,
    title?: string | null,
    meetLink?: string | null,
    conferenceId?: string | null,
    meetCode?: string | null,
    transcriptFileId?: string | null,
    transcriptUrl?: string | null,
    transcriptStatus?: 'pending' | 'found' | 'missing' | 'error' | null,
    summaryFileId?: string | null,
    summaryUrl?: string | null,
    summaryStatus?: 'pending' | 'found' | 'missing' | 'error' | null,
    slackChannelId?: string | null,
    slackThreadTs?: string | null,
    status?: 'scheduled' | 'cancelled' | 'updated' | null,
  },
  messageId: string,
): Promise<void> {
  const botId = topic.botUserId
  const existing = topic.state.perUserContext[botId]?.scheduledEvents
  const list = Array.isArray(existing) ? [...existing] : []
  const idx = list.findIndex((e) =>
    (newEvent.eventId && e.eventId && e.eventId === newEvent.eventId) ||
    (newEvent.iCalUID && e.iCalUID && e.iCalUID === newEvent.iCalUID),
  )
  const base = idx >= 0 ? list[idx] : {}
  const merged = { ...base, ...newEvent }
  if (idx >= 0) list[idx] = merged
  else list.push(merged)
  await updateTopicUserContext(topic.id, botId, { scheduledEvents: list }, messageId)
}

/**
 * Attempt to reschedule a previously created (tagged) event for this topic. Returns true if updated.
 */
export async function tryRescheduleTaggedEvent(
  topicId: string,
  newStartISO: string,
  newEndISO: string,
  messageId?: string,
): Promise<{ success: boolean, meetLink?: string, htmlLink?: string }>{
  try {
    const topic = await getTopicWithState(topicId)
    // Try from stored list first
    const list = topic.state.perUserContext[topic.botUserId]?.scheduledEvents
    const stored = Array.isArray(list) ? list.find((e) => e.calendarId && e.eventId) : null

    const calendarId = stored?.calendarId || getBotCalendarId()
    let eventId = stored?.eventId || null

    if (!eventId) {
      const found = await findTaggedEventForTopic(topicId)
      eventId = found?.id || null
    }
    if (!eventId) return { success: false }

    const oauth2Client = buildOAuthClient()
    oauth2Client.setCredentials({ refresh_token: process.env.PV_GOOGLE_BOT_REFRESH_TOKEN })
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })

    const patchRes = await calendar.events.patch({
      calendarId,
      eventId,
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

    // Persist
    if (messageId) {
      await upsertTopicScheduledEvent(
        topic,
        {
          calendarId,
          eventId,
          iCalUID: updated.iCalUID || null,
          start: newStartISO,
          end: newEndISO,
          title: updated.summary || null,
          meetLink: meetLink || null,
          status: 'updated',
        },
        messageId,
      )
    }

    return { success: true, meetLink, htmlLink: updated.htmlLink || undefined }
  } catch (err) {
    console.error('Error rescheduling calendar event:', err)
    return { success: false }
  }
}

// === Meet transcript/summary discovery (Drive + Docs) ===

function parseMeetCode(url?: string | null): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const m = u.pathname.match(/\/([a-z0-9-]{10,})/i)
    return m ? m[1] : null
  } catch {
    return null
  }
}

async function findDriveDocs(
  auth: calendar_v3.Options['auth'],
  nameContains: string[],
  timeMinISO?: string,
  timeMaxISO?: string,
): Promise<Array<{ id: string, name: string, webViewLink?: string | null }>> {
  const drive = google.drive({ version: 'v3', auth })
  const baseFilters = [
    "mimeType = 'application/vnd.google-apps.document'",
    'trashed = false',
  ]
  if (timeMinISO) baseFilters.push(`createdTime >= '${timeMinISO}'`)
  if (timeMaxISO) baseFilters.push(`createdTime <= '${timeMaxISO}'`)
  const nameClauses = nameContains.map((s) => `name contains '${s.replace(/'/g, "\\'")}'`)
  if (nameClauses.length > 0) baseFilters.push(`(${nameClauses.join(' or ')})`)
  const q = baseFilters.join(' and ')

  const res = await drive.files.list({
    q,
    fields: 'files(id,name,webViewLink,createdTime,modifiedTime)',
    orderBy: 'createdTime desc',
    pageSize: 10,
    supportsAllDrives: false,
    includeItemsFromAllDrives: false,
  })
  const files: drive_v3.Schema$File[] = res.data.files ?? []
  return files.map((f) => ({ id: f.id!, name: f.name!, webViewLink: f.webViewLink || undefined }))
}

export async function scanMeetingArtifacts(slackClient: WebClient): Promise<void> {
  try {
    if (!process.env.PV_GOOGLE_BOT_REFRESH_TOKEN) return

    const oauth2Client = buildOAuthClient()
    oauth2Client.setCredentials({ refresh_token: process.env.PV_GOOGLE_BOT_REFRESH_TOKEN })

    const topics = await getTopics()
    const now = Date.now()

    for (const topic of topics) {
      const botId = topic.botUserId
      const list = topic.state.perUserContext[botId]?.scheduledEvents
      const events = Array.isArray(list) ? list : []

      for (const evt of events) {
        if (evt.status !== 'scheduled') continue
        const endMs = evt.end ? new Date(evt.end).getTime() : null
        if (!endMs || now < endMs + 10 * 60 * 1000) continue // wait 10 minutes after end
        const needTranscript = !evt.transcriptStatus || evt.transcriptStatus === 'pending'
        const needSummary = !evt.summaryStatus || evt.summaryStatus === 'pending'
        if (!needTranscript && !needSummary) continue

        const meetCode = evt.meetCode || parseMeetCode(evt.meetLink || undefined) || undefined
        const timeMinISO = new Date(endMs - 60 * 60 * 1000).toISOString() // 1h before end
        const timeMaxISO = new Date(endMs + 3 * 60 * 60 * 1000).toISOString() // 3h after end

        try {
          let transcriptUrl: string | null = evt.transcriptUrl || null
          let transcriptFileId: string | null = evt.transcriptFileId || null
          let transcriptStatus: 'pending' | 'found' | 'missing' | 'error' | null = evt.transcriptStatus || 'pending'

          let summaryUrl: string | null = evt.summaryUrl || null
          let summaryFileId: string | null = evt.summaryFileId || null
          let summaryStatus: 'pending' | 'found' | 'missing' | 'error' | null = evt.summaryStatus || 'pending'

          if (needTranscript) {
            const terms = ['Transcript']
            if (meetCode) terms.push(meetCode)
            const files = await findDriveDocs(oauth2Client, terms, timeMinISO, timeMaxISO)
            const file = files.find((f) => /transcript/i.test(f.name)) || files[0]
            if (file) {
              transcriptFileId = file.id
              transcriptUrl = file.webViewLink || `https://docs.google.com/document/d/${file.id}/view`
              transcriptStatus = 'found'
            } else if (!evt.transcriptStatus) {
              transcriptStatus = 'pending' // keep pending for future attempts
            }
          }

          if (needSummary) {
            const terms = ['Summary', 'Meeting notes']
            if (meetCode) terms.push(meetCode)
            const files = await findDriveDocs(oauth2Client, terms, timeMinISO, timeMaxISO)
            const file = files.find((f) => /(summary|meeting notes)/i.test(f.name)) || files[0]
            if (file) {
              summaryFileId = file.id
              summaryUrl = file.webViewLink || `https://docs.google.com/document/d/${file.id}/view`
              summaryStatus = 'found'
            } else if (!evt.summaryStatus) {
              summaryStatus = 'pending'
            }
          }

          const messageId = topic.state.createdByMessageId
          await upsertTopicScheduledEvent(
            topic,
            {
              calendarId: evt.calendarId,
              eventId: evt.eventId || null,
              transcriptFileId,
              transcriptUrl,
              transcriptStatus,
              summaryFileId,
              summaryUrl,
              summaryStatus,
            },
            messageId,
          )

          // Post to Slack if we have new links and we know thread info
          const channelId = evt.slackChannelId
          const threadTs = evt.slackThreadTs
          const lines: string[] = []
          if (needTranscript && transcriptStatus === 'found' && transcriptUrl) lines.push(`Transcript: ${transcriptUrl}`)
          if (needSummary && summaryStatus === 'found' && summaryUrl) lines.push(`Summary: ${summaryUrl}`)
          if (lines.length > 0 && channelId && threadTs) {
            try {
              await slackClient.chat.postMessage({
                channel: channelId,
                thread_ts: threadTs,
                text: lines.join('\n'),
              })
            } catch (e) {
              console.warn('Failed to post transcript/summary links to Slack:', e)
            }
          }

        } catch (err) {
          console.warn('Artifact scan failed for topic/event:', topic.id, evt.eventId, err)
        }
      }
    }
  } catch (e) {
    console.warn('scanMeetingArtifacts error:', e)
  }
}

export function startMeetingArtifactsCron(slackClient: WebClient): void {
  const job = new CronJob(
    '15 * * * * *', // 15s past every minute
    () => scanMeetingArtifacts(slackClient),
  )
  job.start()
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
