export function getShortTimezoneFromIANA(iana: string): string {
  try {
    const date = new Date()
    const timeString = date.toLocaleTimeString('en-US', {
      timeZoneName: 'short',
      timeZone: iana,
    })
    const match = timeString.match(/[A-Z]{2,4}$/)
    return match ? match[0] : iana
  } catch {
    return iana
  }
}

export function getShortTimezone(): string {
  return getShortTimezoneFromIANA(Intl.DateTimeFormat().resolvedOptions().timeZone)
}

import type { CalendarEvent } from './api-types.ts'

/**
 * Subtract time ranges from a single event
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