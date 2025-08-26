import { eq, sql, and } from 'drizzle-orm'
import { google } from 'googleapis'
import type { Context } from 'hono'
import { z } from 'zod'

import db from './db/engine'
import { userDataTable, slackUserTable, topicTable, type Topic } from './db/schema/main'
import type { UserContext, CalendarEvent, CalendarRangeLastFetched, TopicUserContext } from '@shared/api-types'
import { mergeCalendarWithOverrides } from '@shared/utils'
import { genFakeCalendar } from './agents'

export interface GoogleAuthTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope: string
  token_type: string
}

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
export async function updateTopicUserContext(topicId: string, slackUserId: string, newContext: TopicUserContext): Promise<Topic> {
  const [topic] = await db
    .select()
    .from(topicTable)
    .where(eq(topicTable.id, topicId))
    .limit(1)

  if (!topic) {
    throw new Error(`Topic ${topicId} not found`)
  }

  const existingContext = topic.perUserContext[slackUserId] || {}
  const mergedContext = { ...existingContext, ...newContext }

  // Update the record
  const updatedPerUserContext = {
    ...topic.perUserContext,
    [slackUserId]: mergedContext,
  }

  const [updatedTopic] = await db
    .update(topicTable)
    .set({
      perUserContext: updatedPerUserContext,
      updatedAt: new Date(),
    })
    .where(eq(topicTable.id, topicId))
    .returning()

  return updatedTopic
}

/**
 * Check if a user has opted out of calendar prompts
 */
async function shouldSuppressCalendarPrompt(slackUserId: string): Promise<boolean> {
  const context = await getUserContext(slackUserId)
  return !!context.suppressCalendarPrompt
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
  const [topic] = await db
    .select()
    .from(topicTable)
    .where(eq(topicTable.id, topicId))
    .limit(1)

  if (!topic) return false

  const userContext = topic.perUserContext[userId]
  return !!userContext?.calendarPrompted
}

/**
 * Add a user to the list of users who have been prompted for calendar connection in a topic
 */
export async function addPromptedUser(topicId: string, userId: string): Promise<void> {
  await updateTopicUserContext(topicId, userId, { calendarPrompted: true })
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

  // Check all conditions for showing calendar buttons
  const hasCalendar = !!userContext.googleAccessToken
  const suppressPrompt = !!userContext.suppressCalendarPrompt

  // Only show buttons if: not already prompted, no calendar, and hasn't suppressed prompts
  return !hasBeenPrompted && !hasCalendar && !suppressPrompt
}


/**
 * Continue scheduling workflow after calendar connection for specific topic
 */
export async function continueSchedulingWorkflow(topicId: string, slackUserId: string) {
  try {
    // Import here to avoid circular dependency
    const { processSchedulingActions } = await import('./slack-message-handler')
    const { slackApp } = await import('./slack-bot')

    // Load the specific topic
    const [topic] = await db
      .select()
      .from(topicTable)
      .where(eq(topicTable.id, topicId))
      .limit(1)

    if (!topic) {
      console.log(`Topic ${topicId} not found`)
      return
    }

    // Verify topic is active and is scheduling workflow
    if (!topic.isActive || topic.workflowType !== 'scheduling') {
      console.log(`Topic ${topicId} is not an active scheduling topic`)
      return
    }

    // Verify user belongs to this topic
    if (!topic.userIds || !topic.userIds.includes(slackUserId)) {
      console.log(`User ${slackUserId} is not part of topic ${topicId}`)
      return
    }

    // Get the user's name for the synthetic message
    const [slackUser] = await db
      .select({ realName: slackUserTable.realName })
      .from(slackUserTable)
      .where(eq(slackUserTable.id, slackUserId))
      .limit(1)

    const userName = slackUser?.realName
    if (!userName) {
      throw new Error(`User ${slackUserId} has no realName in database`)
    }

    console.log(`Continuing scheduling workflow for topic ${topicId} after calendar connection`)

    // Create a synthetic SlackMessage record to trigger scheduling
    const syntheticSlackMessage = {
      id: `synthetic-${Date.now()}`,
      topicId: topic.id,
      channelId: 'synthetic',
      userId: slackUserId,
      text: `${userName} connected their Google Calendar`,
      timestamp: new Date(),
      rawTs: (Date.now() / 1000).toString(),
      threadTs: null,
      raw: {},
    }

    // Process scheduling actions for this specific topic only
    await processSchedulingActions(
      topic.id,
      syntheticSlackMessage,
      slackApp.client,
    )
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

export async function handleGoogleAuthCallback(
  c: Context,
  queryParams: GoogleAuthCallbackReq,
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
      await fetchAndStoreGoogleAuthTokens(code, state)

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
export async function fetchAndStoreGoogleAuthTokens(code: string, state: string) {
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

  // Continue scheduling workflow after successful connection
  await continueSchedulingWorkflow(topicId, slackUserId)
}

/**
 * Fetch calendar events for a user and store in user context
 * This caches calendar data for the LLM to use during scheduling
 */
export async function fetchAndStoreUserCalendar(slackUserId: string, startTime: Date, endTime: Date): Promise<UserContext> {
  try {
    const userContext = await getUserContext(slackUserId)

    if (!userContext.googleAccessToken) {
      console.error(`No google auth token found for user ${slackUserId}`)
      return {}
    // Generate fake calendars if we're testing / evaluating
    } else if (userContext.googleAccessToken === 'fake-token-for-eval') {
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
        calendarEvents.push({
          start: new Date(startTime).toISOString(),
          end: new Date(endTime).toISOString(),
          summary: event.summary || 'Busy',
        })
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
export async function getUserCalendarStructured(slackUserId: string, topic: Topic, startTime: Date, endTime: Date): Promise<CalendarEvent[] | null> {
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
    const topicContext = topic.perUserContext[slackUserId]
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

    // Helper function to check if two events overlap
    const eventsOverlap = (event1: CalendarEvent, event2: CalendarEvent): boolean => {
      const start1 = new Date(event1.start)
      const end1 = new Date(event1.end)
      const start2 = new Date(event2.start)
      const end2 = new Date(event2.end)
      return start1 < end2 && end1 > start2
    }

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
