import { eq, sql } from 'drizzle-orm'
import { google } from 'googleapis'
import type { Context } from 'hono'
import { z } from 'zod'

import db from './db/engine'
import { userDataTable, slackUserTable } from './db/schema/main'
import type { UserContext, CalendarEvent, CalendarRangeLastFetched } from '@shared/api-types'
import { generateFakeCalendarEvents } from './anthropic-api'

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
 * Generate Google OAuth URL for a specific Slack user
 * Includes state parameter to link back to the Slack user after auth
 */
export function generateGoogleAuthUrl(slackUserId: string): string {
  const scope = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ].join(' ')

  const params = new URLSearchParams({
    client_id: process.env.PV_GOOGLE_CLIENT_ID!,
    redirect_uri: GOOGLE_AUTH_REDIRECT_URI,
    response_type: 'code',
    scope,
    state: `slack:${slackUserId}`,
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
    // Parse state to get Slack user info: "slack:U123ABC"
    const [prefix, slackUserId] = state.split(':')

    if (prefix !== 'slack' || !slackUserId) {
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
 * Helper function to subtract multiple time ranges from a given range
 * Returns an array of remaining time ranges after removing all overlaps
 */
function subtractTimeRanges(
  event: CalendarEvent,
  rangesToSubtract: CalendarEvent[],
): CalendarEvent[] {
  // Start with the original event as a single range
  let remainingRanges: CalendarEvent[] = [event]

  // Iteratively subtract each range
  for (const subtractRange of rangesToSubtract) {
    const newRemainingRanges: CalendarEvent[] = []

    for (const range of remainingRanges) {
      const rangeStart = new Date(range.start)
      const rangeEnd = new Date(range.end)
      const subtractStart = new Date(subtractRange.start)
      const subtractEnd = new Date(subtractRange.end)

      // Check if there's an overlap
      if (rangeStart >= subtractEnd || rangeEnd <= subtractStart) {
        // No overlap, keep the entire range
        newRemainingRanges.push(range)
      } else {
        // There's an overlap, split the range

        // Keep the part before the overlap
        if (rangeStart < subtractStart) {
          newRemainingRanges.push({
            ...range,
            start: range.start,
            end: subtractRange.start,
          })
        }

        // Keep the part after the overlap
        if (rangeEnd > subtractEnd) {
          newRemainingRanges.push({
            ...range,
            start: subtractRange.end,
            end: range.end,
          })
        }
      }
    }

    remainingRanges = newRemainingRanges
  }

  return remainingRanges
}

/**
 * Merge calendar events with manual overrides
 * Overrides take precedence and split overlapping events to keep non-overlapping portions
 */
export function mergeCalendarWithOverrides(
  calendarEvents: CalendarEvent[],
  overrides: CalendarEvent[],
): CalendarEvent[] {
  // Process each calendar event to remove overlapping portions with overrides
  const processedEvents: CalendarEvent[] = []

  for (const event of calendarEvents) {
    // Subtract all override ranges from this event
    const remainingPortions = subtractTimeRanges(event, overrides)
    processedEvents.push(...remainingPortions)
  }

  // Combine processed events with overrides
  const mergedEvents = [...processedEvents, ...overrides]

  // Sort by start time
  mergedEvents.sort((a, b) =>
    new Date(a.start).getTime() - new Date(b.start).getTime(),
  )

  return mergedEvents
}

/**
 * Get structured calendar data from userContext
 * Returns calendar events in structured format
 */
export async function getUserCalendarStructured(slackUserId: string, startTime: Date, endTime: Date): Promise<CalendarEvent[] | null> {
  try {
    let context = await getUserContext(slackUserId)

    // Check if the requested range is within the last fetched range, and was fetched within the last 15 minutes
    const bufferTime = 15 * 60 * 1000
    const needsFetch = !context.calendarRangeLastFetched ||
      new Date(context.calendarRangeLastFetched.startTime) > startTime ||
      new Date(context.calendarRangeLastFetched.endTime) < endTime ||
      (Date.now() - new Date(context.calendarRangeLastFetched.fetchedAt).getTime()) > bufferTime

    if (needsFetch) {
      context = await fetchAndStoreUserCalendar(slackUserId, startTime, endTime)
    }

    if (context.calendar) {
      // Filter events to only include those that overlap with the requested time range
      const filteredEvents = context.calendar.filter((event) => {
        const eventStart = new Date(event.start)
        const eventEnd = new Date(event.end)
        return eventStart < endTime && eventEnd > startTime
      })

      // Merge with manual overrides if they exist
      if (context.calendarManualOverrides && context.calendarManualOverrides.length > 0) {
        // Filter overrides to only include those that overlap with the requested time range
        const filteredOverrides = context.calendarManualOverrides.filter((override) => {
          const overrideStart = new Date(override.start)
          const overrideEnd = new Date(override.end)
          return overrideStart < endTime && overrideEnd > startTime
        })

        return mergeCalendarWithOverrides(filteredEvents, filteredOverrides)
      }

      return filteredEvents
    }
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

    const generatedEvents = await generateFakeCalendarEvents(
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
