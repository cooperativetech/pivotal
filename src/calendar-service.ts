import type { AllMiddlewareArgs } from '@slack/bolt'
import { eq, sql } from 'drizzle-orm'
import { google } from 'googleapis'
import type { Context } from 'hono'
import { z } from 'zod'

import db from './db/engine'
import { userDataTable, UserContext } from './db/schema/main'

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
  slackClient: AllMiddlewareArgs['client'],
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
      const slackUserId = await fetchAndStoreGoogleAuthTokens(code, state)
      await fetchAndStoreUserCalendar(slackUserId)

      try {
        await slackClient.chat.postMessage({
          channel: slackUserId,
          text: '✅ Your Google Calendar has been successfully connected! I can now check your availability when scheduling meetings.'
  ,
        })
      } catch (slackError) {
        console.warn('Could not send success message to Slack:', slackError)
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
export async function fetchAndStoreGoogleAuthTokens(code: string, state: string): Promise<string> {
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
  return slackUserId
}

/**
 * Fetch calendar events for a user and store in user context
 * This caches calendar data for the LLM to use during scheduling
 */
export async function fetchAndStoreUserCalendar(slackUserId: string, daysAhead = 7): Promise<UserContext> {
  try {
    const userContext = await getUserContext(slackUserId)

    if (!userContext.googleAccessToken) {
      console.error(`No google auth token found for user ${slackUserId}`)
      return {}
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

    // Define date range
    const startDate = new Date()
    const endDate = new Date()
    endDate.setDate(startDate.getDate() + daysAhead)

    // Fetch events
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    })

    if (!response.data.items) {
      console.error(`No calendar events found for user ${slackUserId}`)
      return {}
    }

    // Convert to the format expected by time_intersection.ts UserProfile
    const busySlots: { start: string; end: string; summary?: string }[] = []

    for (const event of response.data.items) {
      if (!event.start || !event.end) continue

      // Handle both dateTime (specific time) and date (all-day) events
      const startTime = event.start.dateTime || event.start.date
      const endTime = event.end.dateTime || event.end.date

      if (!startTime || !endTime) continue

      const startDateObj = new Date(startTime)
      const endDateObj = new Date(endTime)

      // Format as HH:MM (skip all-day events for now)
      if (event.start.dateTime && event.end.dateTime) {
        busySlots.push({
          start: startDateObj.toTimeString().slice(0, 5), // HH:MM
          end: endDateObj.toTimeString().slice(0, 5), // HH:MM
          summary: event.summary || 'Busy',
        })
      }
    }

    // Store calendar data as simple text in userContext
    const calendarText = busySlots.map((slot) => `${slot.start}-${slot.end}: ${slot.summary || 'Busy'}`).join('\n')
    const calendarData = {
      calendar: calendarText,
      calendarLastFetched: new Date().toISOString(),
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
    console.log(`Stored ${busySlots.length} calendar events for user ${slackUserId}`)

    return newContext

  } catch (error) {
    console.error(`Error fetching calendar for user ${slackUserId}:`, error)
    return {}
  }
}

/**
 * Get calendar data from userContext for use with scheduling algorithms
 * Returns data in UserProfile format compatible with time_intersection.ts
 */
export async function getUserCalendarText(slackUserId: string): Promise<string | null> {
  try {
    let context = await getUserContext(slackUserId)

    // Fetch calendar again if more than 15 minutes have passed since last fetch
    const bufferTime = 15 * 60 * 1000
    if (
      context.calendarLastFetched &&
      new Date(context.calendarLastFetched).getTime() + bufferTime < Date.now()
    ) {
      context = await fetchAndStoreUserCalendar(slackUserId)
    }

    if (context.calendar) {
      return context.calendar
    }

  } catch (error) {
    console.error(`Error getting calendar from context for user ${slackUserId}:`, error)
  }

  return null
}
