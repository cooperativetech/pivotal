import type { CalendarEvent as BenchmarkCalendarEvent, PersonProfile } from './core-benchmark/generate-benchmark-data'
import { updateUserContext } from '../calendar-service'
import db from '../db/engine'
import { slackUserTable } from '../db/schema/main'
import type { CalendarEvent, CalendarRangeLastFetched } from '@shared/api-types'
import { eq, like } from 'drizzle-orm'

/**
 * Convert benchmark calendar events to the structured format used by the bot
 * Matches the format from fetchAndStoreUserCalendar in calendar-service.ts
 */
function convertCalendarToStructured(calendar: BenchmarkCalendarEvent[]): CalendarEvent[] {
  const structuredEvents: CalendarEvent[] = []

  for (const event of calendar) {
    if (event.status === 'cancelled') continue
    if (!event.start.dateTime || !event.end.dateTime) continue

    const start = new Date(event.start.dateTime)
    const end = new Date(event.end.dateTime)

    // Include event type info for critical events
    const summary = event.type === 'critical'
      ? `${event.summary} [UNMOVABLE]`
      : event.summary

    structuredEvents.push({
      start: start.toISOString(),
      end: end.toISOString(),
      summary,
    })
  }

  return structuredEvents
}

/**
 * Store benchmark calendar data in the database for test users
 * This allows the bot to access calendars the same way it does in production
 */
export async function setupCalendarDataForEval(
  profiles: PersonProfile[],
  clearExisting: boolean = true,
): Promise<void> {
  // Clear existing test user data if requested
  if (clearExisting) {
    const testUserIds = profiles.map((_, idx) => `U_USER_${idx}`)
    for (const userId of testUserIds) {
      try {
        await db.delete(slackUserTable).where(eq(slackUserTable.id, userId))
      } catch {
        // Ignore if user doesn't exist
      }
    }
  }

  // Create slack users and store their calendar data
  for (let idx = 0; idx < profiles.length; idx++) {
    const profile = profiles[idx]
    const userId = `U_USER_${idx}`

    // Ensure slack_user exists (required for user_data foreign key)
    await db.insert(slackUserTable)
      .values({
        id: userId,
        teamId: 'T_TEST',
        realName: profile.name,
        isBot: false,
        deleted: false,
        updated: new Date(),
        raw: {},
      })
      .onConflictDoUpdate({
        target: slackUserTable.id,
        set: {
          realName: profile.name,
          updated: new Date(),
        },
      })

    // Convert calendar to structured format and store in user context
    const calendarEvents = convertCalendarToStructured(profile.calendar)

    // Find min and max times from events
    const eventTimes = calendarEvents.flatMap((event) => [
      new Date(event.start).getTime(),
      new Date(event.end).getTime(),
    ])
    const minTime = Math.min(...eventTimes)
    const maxTime = Math.max(...eventTimes)

      // Add 1-day buffer on each side
    const startTime = new Date(minTime - 24 * 60 * 60 * 1000) // minus 1 day
    const endTime = new Date(maxTime + 24 * 60 * 60 * 1000) // plus 1 day

    // Create calendar range tracking - mark the entire range as fetched 1 minute ago
    const oneMinuteAgo = new Date(Date.now() - 60000)
    const calendarRangeLastFetched: CalendarRangeLastFetched = {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      fetchedAt: oneMinuteAgo.toISOString(),
    }

    await updateUserContext(userId, {
      calendar: calendarEvents,
      calendarRangeLastFetched,
      // Simulate having Google auth (so bot thinks calendar is connected)
      googleAccessToken: 'fake-token-for-eval',
      googleRefreshToken: 'fake-refresh-for-eval',
      googleTokenExpiryDate: Date.now() + 3600000, // 1 hour from now
    })

    console.log(`Stored calendar for ${profile.name} (${userId}): ${calendarEvents.length} events`)
  }
}

/**
 * Clear all test user calendar data from the database
 */
export async function clearTestCalendarData(): Promise<void> {
  // Delete all test users (U_USER_*)
  const testUsers = await db.select()
    .from(slackUserTable)
    .where(like(slackUserTable.id, 'U_USER_%'))

  for (const user of testUsers) {
    await db.delete(slackUserTable).where(eq(slackUserTable.id, user.id))
  }

  console.log(`Cleared ${testUsers.length} test users`)
}
