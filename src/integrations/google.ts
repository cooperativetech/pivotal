import { google } from 'googleapis'
import { and, eq } from 'drizzle-orm'
import type { CalendarEvent } from '@shared/api-types'
import db from '../db/engine'
import { auth } from '../auth'
import { accountTable } from '../db/schema/auth'

export async function getLinkedGoogleAccount(userId: string) {
  const [linkedGoogleAccount] = await db.select()
    .from(accountTable)
    .where(and(
      eq(accountTable.userId, userId),
      eq(accountTable.providerId, 'google'),
    ))
    .limit(1)

  if (!linkedGoogleAccount) {
    return null
  }

  const accessToken = await getGoogleAccessToken(userId, linkedGoogleAccount.id)
  if (accessToken === null) {
    return null
  }

  return {
    accountId: linkedGoogleAccount.accountId,
  }
}

export async function getGoogleAccessToken(userId: string, accountPk: string): Promise<string | null> {
  // Check that the account credentials are still valid
  try {
    const { accessToken } = await auth.api.getAccessToken({
      body: {
        providerId: 'google',
        userId,
        accountId: accountPk,
      },
    })
    return accessToken
  } catch (error) {
    if (
      error && typeof error === 'object' && 'message' in error &&
      error.message === 'Failed to get a valid access token'
    ) {
      console.error(`Google access token invalid for user, unlinking account: ${userId}`)
      await db.delete(accountTable).where(eq(accountTable.id, accountPk))
      return null
    }
    throw error
  }
}

export async function getGoogleCalendar(slackUserId: string, startTime: Date, endTime: Date): Promise<CalendarEvent[] | null> {
  try {
    // Query the account table with a self-join to get userId and googleAccountId
    const slackAccounts = db.$with('slack_accounts').as(
      db.select({ userId: accountTable.userId })
        .from(accountTable)
        .where(and(
          eq(accountTable.providerId, 'slack'),
          eq(accountTable.accountId, slackUserId),
        )),
    )

    const [result] = await db.with(slackAccounts)
      .select({
        userId: slackAccounts.userId,
        googleAccountPk: accountTable.id,
      })
      .from(slackAccounts)
      .innerJoin(accountTable, and(
        eq(accountTable.userId, slackAccounts.userId),
        eq(accountTable.providerId, 'google'),
      ))
      .limit(1)

    if (!result) {
      console.log(`No linked Google account found for Slack user ${slackUserId}`)
      return null
    }

    const { userId, googleAccountPk } = result

    const accessToken = await getGoogleAccessToken(userId, googleAccountPk)
    if (!accessToken) {
      return null
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.PV_GOOGLE_CLIENT_ID,
      process.env.PV_GOOGLE_CLIENT_SECRET,
    )
    oauth2Client.setCredentials({ access_token: accessToken })

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client })
    let response
    try {
      response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      })
    } catch (error) {
      if (
        error && typeof error === 'object' && 'message' in error &&
        (error.message as string).startsWith('Request had invalid authentication credentials.')
      ) {
        console.error(`Google access token invalid for user, unlinking account: ${userId}`)
        await db.delete(accountTable).where(eq(accountTable.id, googleAccountPk))
        return null
      }
      throw error
    }

    if (!response?.data.items) {
      console.log(`No calendar events found for user ${slackUserId}`)
      return []
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

    return calendarEvents
  } catch (error) {
    console.error(`Error fetching google calendar for user ${slackUserId}:`, error)
    return null
  }
}

export async function isGoogleCalendarConnected(slackUserId: string): Promise<boolean> {
  const now = new Date()
  const nowPlusOneMinute = new Date(now.getTime() + 60 * 1000)
  const calendar = await getGoogleCalendar(slackUserId, now, nowPlusOneMinute)
  return calendar !== null
}
