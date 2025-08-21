import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Types for calendar events and scheduling (matching Google Calendar API structure)
export interface CalendarEvent {
  id: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  summary: string
  description?: string
  location?: string
  organizer?: {
    email: string
  }
  start: {
    dateTime?: string // ISO 8601 format with timezone
    date?: string // For all-day events
    timeZone?: string
  }
  end: {
    dateTime?: string
    date?: string
    timeZone?: string
  }
  attendees?: Array<{
    email: string
    responseStatus: 'accepted' | 'declined' | 'tentative' | 'needsAction'
    self?: boolean
    organizer?: boolean
  }>
  recurringEventId?: string
  transparency?: 'opaque' | 'transparent'
  visibility?: 'default' | 'public' | 'private' | 'confidential'
  type?: 'free' | 'blocked-work' | 'meeting' | 'personal' | 'critical' // Custom field for utility calculation
}

// Utility values for different event types when scheduling over them
export interface UtilityConfig {
  free: number         // Max utility when slot is free (e.g., 100)
  blockedWork: number  // Medium penalty for work time (e.g., 70)
  meeting: number      // Low utility for double-booking (e.g., 20)
  personal: number     // Medium-low utility for personal time (e.g., 40)
  critical: number     // Min utility for critical events like picking up kids (e.g., 0)
}

// Person profile with their calendar and utility preferences
export interface PersonProfile {
  name: string
  calendar: CalendarEvent[]
  utilityConfig: UtilityConfig
}

// Proposed meeting time
export interface TimeSlot {
  start: string // HH:MM format
  end: string   // HH:MM format
}

// Helper function to convert minutes since midnight to time string
function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

// Helper function to convert time string to minutes since midnight
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

// Check if two time slots overlap
function timeSlotsOverlap(slot1: TimeSlot, slot2: TimeSlot): boolean {
  const start1 = timeToMinutes(slot1.start)
  const end1 = timeToMinutes(slot1.end)
  const start2 = timeToMinutes(slot2.start)
  const end2 = timeToMinutes(slot2.end)

  return start1 < end2 && start2 < end1
}

// Extract time from ISO datetime string to HH:MM format
function extractTime(dateTime: string): string {
  const date = new Date(dateTime)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

// Create ISO datetime string for a specific date and time
function createDateTime(date: Date, time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  const dt = new Date(date)
  dt.setHours(hours, minutes, 0, 0)
  return dt.toISOString()
}

// Calculate utility for a person given a proposed time slot
function calculatePersonUtility(
  person: PersonProfile,
  proposedTime: TimeSlot,
): { utility: number; conflictingEvent?: CalendarEvent } {
  // Find all events that conflict with the proposed time
  const conflicts = person.calendar.filter((event) => {
    if (event.status === 'cancelled') return false
    if (!event.start.dateTime || !event.end.dateTime) return false

    const eventSlot = {
      start: extractTime(event.start.dateTime),
      end: extractTime(event.end.dateTime),
    }
    return timeSlotsOverlap(proposedTime, eventSlot)
  })

  // If no conflicts, return max utility (free time)
  if (conflicts.length === 0) {
    return { utility: person.utilityConfig.free }
  }

  // Find the most restrictive conflict (lowest utility)
  let minUtility = person.utilityConfig.free
  let worstConflict: CalendarEvent | undefined

  for (const conflict of conflicts) {
    let utility: number
    switch (conflict.type) {
      case 'free':
        utility = person.utilityConfig.free
        break
      case 'blocked-work':
        utility = person.utilityConfig.blockedWork
        break
      case 'meeting':
        utility = person.utilityConfig.meeting
        break
      case 'personal':
        utility = person.utilityConfig.personal
        break
      case 'critical':
        utility = person.utilityConfig.critical
        break
      default:
        // Default to meeting if type is not specified
        utility = person.utilityConfig.meeting
        break
    }

    if (utility < minUtility) {
      minUtility = utility
      worstConflict = conflict
    }
  }

  return { utility: minUtility, conflictingEvent: worstConflict }
}

// Calculate total utility across all participants for a given time slot
function calculateTotalUtility(
  profiles: PersonProfile[],
  proposedTime: TimeSlot,
): { total: number; individual: Array<{ person: string; utility: number; conflictingEvent?: CalendarEvent }> } {
  const individual = profiles.map((person) => {
    const result = calculatePersonUtility(person, proposedTime)
    return {
      person: person.name,
      utility: result.utility,
      conflictingEvent: result.conflictingEvent,
    }
  })

  const total = individual.reduce((sum, score) => sum + score.utility, 0)

  return { total, individual }
}

// Generate all possible 1-hour time slots for a day
function generateAllTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = []

  // Generate 1-hour slots starting every 15 minutes
  // Within working hours: 9:00 AM to 5:00 PM (last slot is 4:00-5:00)
  // 9:00 = 540 minutes, 16:00 = 960 minutes (last start time for 1-hour slot ending at 5pm)
  for (let startMinutes = 9 * 60; startMinutes <= 16 * 60; startMinutes += 15) {
    slots.push({
      start: minutesToTime(startMinutes),
      end: minutesToTime(startMinutes + 60),
    })
  }

  return slots
}

// Main evaluation function - evaluate a proposed meeting time
export function evaluateMeetingTime(
  profiles: PersonProfile[],
  proposedTime: TimeSlot,
): {
  proposedTime: TimeSlot
  totalUtility: number
  maxPossibleUtility: number
  minPossibleUtility: number
  percentile: number
  individualScores: Array<{
    person: string
    utility: number
    conflictingEvent?: CalendarEvent
  }>
} {
  // Calculate utility for proposed time
  const { total, individual } = calculateTotalUtility(profiles, proposedTime)

  // Find min/max across all possible times
  const allSlots = generateAllTimeSlots()
  const allScores = new Map<string, number>()

  let min = Infinity
  let max = -Infinity

  for (const slot of allSlots) {
    const { total: slotTotal } = calculateTotalUtility(profiles, slot)
    const key = `${slot.start}-${slot.end}`
    allScores.set(key, slotTotal)

    if (slotTotal < min) min = slotTotal
    if (slotTotal > max) max = slotTotal
  }

  // Calculate percentile
  if (total === max) {
    return {
      proposedTime,
      totalUtility: total,
      maxPossibleUtility: max,
      minPossibleUtility: min,
      percentile: 100,
      individualScores: individual,
    }
  }

  // Calculate what percentage of slots are worse
  let worseCount = 0
  allScores.forEach((score) => {
    if (score < total) worseCount++
  })

  const percentile = (worseCount / allScores.size) * 100

  return {
    proposedTime,
    totalUtility: total,
    maxPossibleUtility: max,
    minPossibleUtility: min,
    percentile: Math.round(percentile * 100) / 100,
    individualScores: individual,
  }
}

// Helper function to get next Tuesday with error handling
function getNextTuesday(): Date {
  const today = new Date()
  const currentDay = today.getDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  // Calculate days until next Tuesday (Tuesday = 2)
  let daysUntilTuesday: number
  if (currentDay === 2) {
    // If today is Tuesday, get next Tuesday (7 days from now)
    daysUntilTuesday = 7
  } else if (currentDay < 2) {
    // If today is Sunday (0) or Monday (1), Tuesday is this week
    daysUntilTuesday = 2 - currentDay
  } else {
    // If today is Wednesday (3) through Saturday (6), Tuesday is next week
    daysUntilTuesday = 7 - currentDay + 2
  }

  const nextTuesday = new Date(today)
  nextTuesday.setDate(today.getDate() + daysUntilTuesday)
  nextTuesday.setHours(0, 0, 0, 0)

  // Validate the result
  if (nextTuesday.getDay() !== 2) {
    throw new Error(`Date calculation error: Expected Tuesday (2), got ${nextTuesday.getDay()}`)
  }

  if (nextTuesday <= today) {
    throw new Error('Date calculation error: Next Tuesday should be in the future')
  }

  return nextTuesday
}

// Configuration for random calendar generation
interface CalendarGenerationConfig {
  minEvents: number
  maxEvents: number
  eventTypeProbabilities: {
    meeting: number
    blockedWork: number
    personal: number
    critical: number
  }
  // Working hours (in minutes from midnight)
  workdayStart: number // e.g., 480 for 8:00
  workdayEnd: number   // e.g., 1080 for 18:00
}

// Generate a random calendar for one person
function generateRandomCalendar(config: CalendarGenerationConfig, personName: string): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const numEvents = Math.floor(Math.random() * (config.maxEvents - config.minEvents + 1)) + config.minEvents

  // Track occupied time slots to avoid overlaps
  const occupiedSlots = new Set<string>()

  // Use next Tuesday as the base date for all events
  const baseDate = getNextTuesday()

  for (let i = 0; i < numEvents; i++) {
    let attempts = 0
    let event: CalendarEvent | null = null

    // Try to create non-overlapping event (max 50 attempts)
    while (attempts < 50 && !event) {
      // Random start time within working hours
      const startMinutes = Math.floor(
        Math.random() * (config.workdayEnd - config.workdayStart - 60) + config.workdayStart,
      )

      // Round to nearest 30 minutes
      const roundedStart = Math.floor(startMinutes / 30) * 30

      // Random duration: 30, 60, or 90 minutes
      const duration = [30, 60, 90][Math.floor(Math.random() * 3)]
      const endMinutes = roundedStart + duration

      // Check if this slot is available
      const slotKey = `${roundedStart}-${endMinutes}`
      if (!occupiedSlots.has(slotKey) && endMinutes <= config.workdayEnd) {
        // Mark all overlapping 30-min slots as occupied
        for (let m = roundedStart; m < endMinutes; m += 30) {
          occupiedSlots.add(`${m}-${m + 30}`)
        }

        // Determine event type based on probabilities
        const rand = Math.random()
        let eventType: 'meeting' | 'blocked-work' | 'personal' | 'critical'
        const probs = config.eventTypeProbabilities

        if (rand < probs.critical) {
          eventType = 'critical'
        } else if (rand < probs.critical + probs.personal) {
          eventType = 'personal'
        } else if (rand < probs.critical + probs.personal + probs.blockedWork) {
          eventType = 'blocked-work'
        } else {
          eventType = 'meeting'
        }

        // Generate description based on type
        const summaries = {
          meeting: ['Team sync', 'Client call', '1:1 with manager', 'Planning session', 'Review meeting', 'Standup', 'Product demo', 'Design review'],
          'blocked-work': ['Focus time', 'Deep work', 'Project work', 'Code review', 'Documentation', 'Development time'],
          personal: ['Lunch', 'Gym', 'Errand', 'Doctor appointment', 'Break', 'Personal time'],
          critical: ['Pick up kids from school', 'Medical appointment', 'Flight to conference', 'School event', 'Emergency meeting'],
        }

        const summary = summaries[eventType][Math.floor(Math.random() * summaries[eventType].length)]

        // Generate event ID similar to Google's format
        const eventId = `${Math.random().toString(36).substring(2, 15)}_${baseDate.toISOString().replace(/[-:]/g, '').substring(0, 8)}T${roundedStart.toString().padStart(4, '0')}00Z`

        // Create start and end DateTimes
        const startDateTime = createDateTime(baseDate, minutesToTime(roundedStart))
        const endDateTime = createDateTime(baseDate, minutesToTime(endMinutes))

        // Create email for the person
        const email = `${personName.toLowerCase().replace(/\s+/g, '.')}@example.com`

        event = {
          id: eventId,
          status: 'confirmed',
          summary,
          description: eventType === 'critical' ? 'Cannot be moved or rescheduled' : undefined,
          start: {
            dateTime: startDateTime,
            timeZone: 'America/Los_Angeles',
          },
          end: {
            dateTime: endDateTime,
            timeZone: 'America/Los_Angeles',
          },
          organizer: {
            email,
          },
          attendees: [
            {
              email,
              responseStatus: 'accepted',
              self: true,
              organizer: true,
            },
          ],
          type: eventType, // Custom field for utility calculation
        }

        // Add additional attendees for meetings
        if (eventType === 'meeting' && Math.random() > 0.3) {
          const numAttendees = Math.floor(Math.random() * 3) + 1
          for (let j = 0; j < numAttendees; j++) {
            event.attendees?.push({
              email: `colleague${j + 1}@example.com`,
              responseStatus: Math.random() > 0.2 ? 'accepted' : 'tentative',
            })
          }
        }

        // Some events might be recurring
        if (eventType === 'meeting' && Math.random() > 0.7) {
          event.recurringEventId = `${Math.random().toString(36).substring(2, 10)}`
        }
      }

      attempts++
    }

    if (event) {
      events.push(event)
    }
  }

  // Sort events by start time
  events.sort((a, b) => {
    const aStart = new Date(a.start.dateTime!).getTime()
    const bStart = new Date(b.start.dateTime!).getTime()
    return aStart - bStart
  })

  return events
}

// Generate random utility configuration with some variation
function generateRandomUtilityConfig(): UtilityConfig {
  // Base utilities with some random variation
  return {
    free: 100, // Always max
    blockedWork: 60 + Math.floor(Math.random() * 20), // 60-80
    meeting: 10 + Math.floor(Math.random() * 20), // 10-30
    personal: 30 + Math.floor(Math.random() * 20), // 30-50
    critical: 0, // Always min
  }
}

// Generate N random person profiles
export function generateRandomProfiles(
  numPeople: number,
  calendarConfig?: Partial<CalendarGenerationConfig>,
): PersonProfile[] {
  const defaultConfig: CalendarGenerationConfig = {
    minEvents: 3,
    maxEvents: 8,
    eventTypeProbabilities: {
      meeting: 0.4,
      blockedWork: 0.3,
      personal: 0.2,
      critical: 0.1,
    },
    workdayStart: 8 * 60, // 8:00
    workdayEnd: 18 * 60,  // 18:00
  }

  const config = { ...defaultConfig, ...calendarConfig }

  const names = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack',
    'Kate', 'Liam', 'Maya', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Ruby', 'Sam', 'Tara',
  ]

  const profiles: PersonProfile[] = []

  for (let i = 0; i < numPeople; i++) {
    const personName = names[i % names.length] + (i >= names.length ? i.toString() : '')
    profiles.push({
      name: personName,
      calendar: generateRandomCalendar(config, personName),
      utilityConfig: generateRandomUtilityConfig(),
    })
  }

  return profiles
}

export interface BenchmarkTestCase {
  id: number
  profiles: PersonProfile[]
  aggregateRawText?: string  // Conversation history from all participants
  utilityDistribution: {
    timeSlot: TimeSlot
    totalUtility: number
  }[]
  optimalSlots: TimeSlot[]
  optimalUtility: number
}

function generateTestCase(id: number): BenchmarkTestCase {
  // Generate random profiles
  const profiles = generateRandomProfiles(5)

  // Calculate utility for all possible time slots
  const allSlots = generateAllTimeSlots()
  const utilityDistribution = allSlots.map((slot) => {
    const { total } = calculateTotalUtility(profiles, slot)
    return {
      timeSlot: slot,
      totalUtility: total,
    }
  })

  // Find optimal slots (there may be ties)
  const maxUtility = Math.max(...utilityDistribution.map((d) => d.totalUtility))
  const optimalSlots = utilityDistribution
    .filter((d) => d.totalUtility === maxUtility)
    .map((d) => d.timeSlot)

  return {
    id,
    profiles,
    utilityDistribution,
    optimalSlots,
    optimalUtility: maxUtility,
  }
}

/**
 * Generate multiple test cases with current "next Tuesday" dates
 * This replaces loading static JSON files with hardcoded dates
 */
export function generateBenchmarkTestCases(numCases: number): BenchmarkTestCase[] {
  const testCases: BenchmarkTestCase[] = []

  for (let i = 0; i < numCases; i++) {
    testCases.push(generateTestCase(i))
  }

  return testCases
}

export function generateBenchmarkData(numCases: number = 100): void {
  console.log(`Generating ${numCases} benchmark test cases...`)

  const testCases: BenchmarkTestCase[] = []

  for (let i = 0; i < numCases; i++) {
    if (i > 0 && i % 100 === 0) {
      console.log(`Progress: ${i}/${numCases} cases generated`)
    }

    const testCase = generateTestCase(i)
    testCases.push(testCase)
  }

  // Ensure data directory exists
  const dataDir = join(import.meta.dirname, '..', 'data')
  mkdirSync(dataDir, { recursive: true })

  // Save to file
  const filename = `benchmark-data-${numCases}-cases.json`
  const filepath = join(dataDir, filename)
  writeFileSync(filepath, JSON.stringify(testCases, null, 2))

  // Print summary statistics
  console.log(`\nGenerated ${numCases} test cases`)
  console.log(`Saved to: ${filepath}`)

  // Analyze utility distributions
  const allUtilityValues = testCases.flatMap((tc) =>
    tc.utilityDistribution.map((d) => d.totalUtility),
  )
  const uniqueUtilities = [...new Set(allUtilityValues)].sort((a, b) => a - b)

  console.log('\nUtility Distribution Summary:')
  console.log(`  Unique utility values: ${uniqueUtilities.length}`)
  console.log(`  Min utility: ${Math.min(...uniqueUtilities)}`)
  console.log(`  Max utility: ${Math.max(...uniqueUtilities)}`)
  console.log(`  Median utility: ${uniqueUtilities[Math.floor(uniqueUtilities.length / 2)]}`)

  // Check how many cases have unique optimals vs ties
  const uniqueOptimalCount = testCases.filter((tc) => tc.optimalSlots.length === 1).length
  console.log('\nOptimal slot statistics:')
  console.log(`  Cases with unique optimal: ${uniqueOptimalCount} (${(uniqueOptimalCount / numCases * 100).toFixed(1)}%)`)
  console.log(`  Cases with tied optimals: ${numCases - uniqueOptimalCount} (${((numCases - uniqueOptimalCount) / numCases * 100).toFixed(1)}%)`)
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const numCases = parseInt(process.argv[2] || '100')
  generateBenchmarkData(numCases)
}