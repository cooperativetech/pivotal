/**
 * @file time-intersection-tool.ts
 *
 * Core pipeline for multi-person free-time intersection, translated from Python.
 * This module is self-contained and uses native JavaScript Date objects for all calculations.
 *
 * 1) normalizeCalendars: Parses user calendars into merged busy intervals.
 * 2) findCommonFreeTime: Inverts and intersects busy times to get common free intervals within a specified time range.
 */

// --- Type Definitions ---

/** A tuple representing a start and end time for an interval. */
type DateTimeInterval = {
  start: Date,
  end: Date,
}

/** The expected structure for a user's profile and calendar data. */
export interface UserProfile {
  name: string
  calendar: {
    start: Date
    end: Date
    summary: string
  }[]
}

// --- Core Interval Primitives ---

/**
 * Merges overlapping and adjacent date intervals into a sorted, non-overlapping list.
 * @param intervals - A list of date intervals.
 * @returns A new list of merged intervals.
 */
function merge(intervals: DateTimeInterval[]): DateTimeInterval[] {
  if (intervals.length === 0) {
    return []
  }

  // Sort intervals by their start time
  intervals.sort((a, b) => a.start.getTime() - b.start.getTime())

  const merged: DateTimeInterval[] = [intervals[0]]

  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]
    const current = intervals[i]

    // If the current interval overlaps with the last one, merge them
    if (current.start <= last.end) {
      last.end = new Date(Math.max(last.end.getTime(), current.end.getTime()))
    } else {
      merged.push(current)
    }
  }
  return merged
}

/**
 * Subtracts a list of busy intervals from a given time window to find free intervals.
 * @param busy - A sorted, non-overlapping list of busy intervals.
 * @param window - The time window to find free time within.
 * @returns A list of free intervals.
 */
function invert(busy: DateTimeInterval[], window: DateTimeInterval): DateTimeInterval[] {
  const free: DateTimeInterval[] = []
  let cursor = window.start

  for (const interval of busy) {
    if (cursor < interval.start) {
      free.push({ start: cursor, end: interval.start })
    }
    cursor = new Date(Math.max(cursor.getTime(), interval.end.getTime()))
  }

  if (cursor < window.end) {
    free.push({ start: cursor, end: window.end })
  }

  return free
}

/**
 * Finds the intersection of two lists of sorted, non-overlapping intervals.
 * @param a - The first list of intervals.
 * @param b - The second list of intervals.
 * @returns A new list containing only the overlapping intervals.
 */
function intersect(a: DateTimeInterval[], b: DateTimeInterval[]): DateTimeInterval[] {
  const intersection: DateTimeInterval[] = []
  let i = 0
  let j = 0

  while (i < a.length && j < b.length) {
    const start = new Date(Math.max(a[i].start.getTime(), b[j].start.getTime()))
    const end = new Date(Math.min(a[i].end.getTime(), b[j].end.getTime()))

    if (start < end) {
      intersection.push({ start, end })
    }

    if (a[i].end < b[j].end) {
      i++
    } else {
      j++
    }
  }
  return intersection
}


// --- Pipeline Functions ---

/**
 * Converts raw user profiles into a map of user names to their merged busy intervals.
 * @param profiles - A list of user profiles.
 * @returns A dictionary mapping user names to their busy time intervals.
 */
function normalizeCalendars(profiles: UserProfile[]): Record<string, DateTimeInterval[]> {
  const busyMap: Record<string, DateTimeInterval[]> = {}

  for (const profile of profiles) {
    const rawIntervals: DateTimeInterval[] = profile.calendar.map((event) => ({
      start: event.start,
      end: event.end,
    }))
    busyMap[profile.name] = merge(rawIntervals)
  }

  return busyMap
}

// --- Main Exported Function ---

/**
 * The main function for the tool. It takes user profiles and calculates
 * common free time within the specified time range.
 * @param profiles - An array of user profiles with their calendar data.
 * @param startTime - The start of the time range to search for free slots.
 * @param endTime - The end of the time range to search for free slots.
 * @returns An array of common free time slots.
 */
export function findCommonFreeTime(profiles: UserProfile[], startTime: Date, endTime: Date): DateTimeInterval[] {
  if (!profiles || profiles.length === 0) {
    return []
  }

  const busyMap = normalizeCalendars(profiles)

  // Use the provided start and end times as the search window
  const window: DateTimeInterval = { start: startTime, end: endTime }

  // Invert each user's busy schedule to get their free time
  const freeLists = Object.values(busyMap).map((busyIntervals) => invert(busyIntervals, window))
  // Find the intersection of all users' free time
  // Start with the full window as the initial free time, then intersect with each user's free time
  const commonFree = freeLists.length > 0
    ? freeLists.reduce((acc, freeList) => intersect(acc, freeList), [window])
    : []

  return commonFree
}

// --- Conversion Functions ---

/**
 * Converts CalendarEvent array from the database schema (with ISO string dates)
 * to the format expected by UserProfile (with Date objects).
 * Filters out events where free=true (only keeps busy events).
 * @param events - Array of CalendarEvent objects from the database
 * @returns Array of calendar events with Date objects (only busy events)
 */
export function convertCalendarEventsToUserProfile(
  events: Array<{ start: string; end: string; summary: string; free?: boolean }>,
): Array<{ start: Date; end: Date; summary: string }> {
  return events
    .filter((event) => !event.free) // Only keep busy events (free !== true)
    .map((event) => ({
      start: new Date(event.start),
      end: new Date(event.end),
      summary: event.summary,
    }))
}

