/**
 * @file time-intersection-tool.ts
 *
 * Core pipeline for multi-person free-time intersection, translated from Python.
 * This module is self-contained and uses native JavaScript Date objects for all calculations.
 *
 * 1) normalizeCalendars: Parses user calendars into merged busy intervals.
 * 2) findCommonFree: Inverts and intersects busy times to get common free intervals.
 * 3) getAcceptableTimes: Filters the free intervals based on configurable start/end times.
 */

// --- Type Definitions ---

/** A tuple representing a start and end time for an interval. */
type DateTimeInterval = [Date, Date]

/** The expected structure for a user's profile and calendar data. */
export interface UserProfile {
  name: string
  calendar: { 
    start: string  // Can be either "HH:MM" or ISO datetime string
    end: string    // Can be either "HH:MM" or ISO datetime string
    summary?: string
    type?: string
  }[]
}

/** The structure for a calculated free time slot. */
export interface FreeSlot {
  start: string // HH:MM format
  end: string   // HH:MM format
}

// --- Global Configuration ---

// Define acceptable hours for scheduling.
const ACCEPTABLE_START_HOUR = 6 // 6:00 AM
const ACCEPTABLE_END_HOUR = 22 // 10:00 PM

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
  intervals.sort((a, b) => a[0].getTime() - b[0].getTime())

  const merged: DateTimeInterval[] = [intervals[0]]

  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1]
    const current = intervals[i]

    // If the current interval overlaps with the last one, merge them
    if (current[0] <= last[1]) {
      last[1] = new Date(Math.max(last[1].getTime(), current[1].getTime()))
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
  let cursor = window[0]

  for (const [start, end] of busy) {
    if (cursor < start) {
      free.push([cursor, start])
    }
    cursor = new Date(Math.max(cursor.getTime(), end.getTime()))
  }

  if (cursor < window[1]) {
    free.push([cursor, window[1]])
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
    const start = new Date(Math.max(a[i][0].getTime(), b[j][0].getTime()))
    const end = new Date(Math.min(a[i][1].getTime(), b[j][1].getTime()))

    if (start < end) {
      intersection.push([start, end])
    }

    if (a[i][1] < b[j][1]) {
      i++
    } else {
      j++
    }
  }
  return intersection
}


// --- Pipeline Functions ---

/**
 * Parses a time string and returns a Date object.
 * Handles both "HH:MM" format and ISO datetime strings.
 * @param timeStr - The time string in "HH:MM" or ISO format.
 * @returns A Date object.
 */
function parseTime(timeStr: string): Date {
    // Check if it's an ISO datetime string (contains 'T' or looks like a date)
    if (timeStr.includes('T') || timeStr.includes('-')) {
        return new Date(timeStr)
    }
    
    // Otherwise, assume it's HH:MM format
    const [hours, minutes] = timeStr.split(':').map(Number)
    const date = new Date()
    date.setHours(hours, minutes, 0, 0)
    return date
}


/**
 * Converts raw user profiles into a map of user names to their merged busy intervals.
 * @param profiles - A list of user profiles.
 * @returns A dictionary mapping user names to their busy time intervals.
 */
function normalizeCalendars(profiles: UserProfile[]): Record<string, DateTimeInterval[]> {
  const busyMap: Record<string, DateTimeInterval[]> = {}

  for (const profile of profiles) {
    const rawIntervals: DateTimeInterval[] = profile.calendar.map((event) => [
      parseTime(event.start),
      parseTime(event.end),
    ])
    busyMap[profile.name] = merge(rawIntervals)
  }

  return busyMap
}

/**
 * Filters a list of free intervals to only include those within acceptable hours.
 * @param commonFree - A list of common free time intervals.
 * @returns A list of intervals that fall within the acceptable time window.
 */
function getAcceptableTimes(commonFree: DateTimeInterval[]): DateTimeInterval[] {
  const today = new Date()
  const startTime = new Date(today)
  startTime.setHours(ACCEPTABLE_START_HOUR, 0, 0, 0)
  const endTime = new Date(today)
  endTime.setHours(ACCEPTABLE_END_HOUR, 0, 0, 0)
  const acceptableWindow: DateTimeInterval = [startTime, endTime]
  return intersect(commonFree, [acceptableWindow])
}

/**
 * Formats a Date object into a "HH:MM" string.
 * @param date - The Date object to format.
 * @returns A string in "HH:MM" format.
 */
function formatTime(date: Date): string {
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
}


// --- Main Exported Function ---

/**
 * The main function for the tool. It takes user profiles, calculates the
 * common free time within acceptable hours, and returns it in a simple format.
 * @param profiles - An array of user profiles with their calendar data.
 * @returns An array of common free time slots.
 */
export function findCommonFreeTime(profiles: UserProfile[]): FreeSlot[] {
  if (!profiles || profiles.length === 0) {
    return []
  }

  const busyMap = normalizeCalendars(profiles)

  // Define the full day window for today
  const today = new Date()
  const startOfDay = new Date(today)
  startOfDay.setHours(0, 0, 0, 0)
  const endOfDay = new Date(today)
  endOfDay.setHours(23, 59, 59, 999)
  const window: DateTimeInterval = [startOfDay, endOfDay]

  // Invert each user's busy schedule to get their free time
  const freeLists = Object.values(busyMap).map((busyIntervals) => invert(busyIntervals, window))
  // Find the intersection of all users' free time
  // Start with the full window as the initial free time, then intersect with each user's free time
  const commonFree = freeLists.length > 0 
    ? freeLists.reduce((acc, freeList) => intersect(acc, freeList), [window])
    : []

  // Filter for acceptable times
  const acceptableSlots = getAcceptableTimes(commonFree)

  // Format for the final output
  return acceptableSlots.map(([start, end]) => ({
      start: formatTime(start),
      end: formatTime(end),
  }))
}