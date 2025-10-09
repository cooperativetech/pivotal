import { Temporal } from '@js-temporal/polyfill'

import type { RecurrencePattern } from '@shared/api-types'
import { isRecurrenceDayCode, type RecurrenceDayCode } from '@shared/recurrence'

export function normalizeRecurrencePattern(pattern: RecurrencePattern): RecurrencePattern {
  const cleanedByDay: RecurrenceDayCode[] | undefined = pattern.byDay
    ? Array.from(new Set(pattern.byDay
        .map((day) => typeof day === 'string' ? day.toUpperCase() : day)
        .filter(isRecurrenceDayCode)))
    : undefined

  if ((pattern.frequency === 'WEEKLY' || pattern.frequency === 'BIWEEKLY') && (!cleanedByDay || cleanedByDay.length === 0)) {
    throw new Error(`Recurring frequency ${pattern.frequency} requires at least one weekday`)
  }

  const rawInterval = Number.isFinite(pattern.interval) ? Math.trunc(pattern.interval) : 1
  const baseInterval = rawInterval > 0 ? rawInterval : 1
  const interval = pattern.frequency === 'BIWEEKLY' ? Math.max(2, baseInterval) : baseInterval

  try {
    Temporal.Now.instant().toZonedDateTimeISO(pattern.timezone)
  } catch {
    throw new Error(`Invalid recurrence timezone: ${pattern.timezone}`)
  }

  const untilDate = new Date(pattern.until)
  if (Number.isNaN(untilDate.getTime())) {
    throw new Error(`Invalid recurrence 'until' value: ${pattern.until}`)
  }

  return {
    frequency: pattern.frequency,
    byDay: cleanedByDay,
    interval,
    until: untilDate.toISOString(),
    timezone: pattern.timezone,
  }
}
