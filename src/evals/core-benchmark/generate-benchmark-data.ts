import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Types for calendar events and scheduling
export interface CalendarEvent {
  start: string // Time in HH:MM format (24hr)
  end: string   // Time in HH:MM format (24hr)
  type: 'free' | 'blocked-work' | 'meeting' | 'personal' | 'critical' // Event type
  description: string
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

// Calculate utility for a person given a proposed time slot
function calculatePersonUtility(
  person: PersonProfile,
  proposedTime: TimeSlot,
): { utility: number; conflictingEvent?: CalendarEvent } {
  // Find all events that conflict with the proposed time
  const conflicts = person.calendar.filter(event =>
    timeSlotsOverlap(proposedTime, { start: event.start, end: event.end }),
  )

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
  const individual = profiles.map(person => {
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

  // Generate 24 1-hour slots from 00:00 to 23:00
  for (let hour = 0; hour < 24; hour++) {
    slots.push({
      start: minutesToTime(hour * 60),
      end: minutesToTime((hour + 1) * 60),
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
  allScores.forEach(score => {
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
function generateRandomCalendar(config: CalendarGenerationConfig): CalendarEvent[] {
  const events: CalendarEvent[] = []
  const numEvents = Math.floor(Math.random() * (config.maxEvents - config.minEvents + 1)) + config.minEvents

  // Track occupied time slots to avoid overlaps
  const occupiedSlots = new Set<string>()

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
        const descriptions = {
          meeting: ['Team sync', 'Client call', '1:1', 'Planning session', 'Review meeting'],
          'blocked-work': ['Focus time', 'Deep work', 'Project work', 'Code review', 'Documentation'],
          personal: ['Lunch', 'Gym', 'Errand', 'Appointment', 'Break'],
          critical: ['Pick up kids', 'Medical appointment', 'Flight', 'School event', 'Emergency'],
        }

        event = {
          start: minutesToTime(roundedStart),
          end: minutesToTime(endMinutes),
          type: eventType,
          description: descriptions[eventType][Math.floor(Math.random() * descriptions[eventType].length)],
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
    const aStart = parseInt(a.start.split(':')[0]) * 60 + parseInt(a.start.split(':')[1])
    const bStart = parseInt(b.start.split(':')[0]) * 60 + parseInt(b.start.split(':')[1])
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
    profiles.push({
      name: names[i % names.length] + (i >= names.length ? i.toString() : ''),
      calendar: generateRandomCalendar(config),
      utilityConfig: generateRandomUtilityConfig(),
    })
  }

  return profiles
}

interface BenchmarkTestCase {
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
  const utilityDistribution = allSlots.map(slot => {
    const { total } = calculateTotalUtility(profiles, slot)
    return {
      timeSlot: slot,
      totalUtility: total,
    }
  })

  // Find optimal slots (there may be ties)
  const maxUtility = Math.max(...utilityDistribution.map(d => d.totalUtility))
  const optimalSlots = utilityDistribution
    .filter(d => d.totalUtility === maxUtility)
    .map(d => d.timeSlot)

  return {
    id,
    profiles,
    utilityDistribution,
    optimalSlots,
    optimalUtility: maxUtility,
  }
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
  const allUtilityValues = testCases.flatMap(tc =>
    tc.utilityDistribution.map(d => d.totalUtility),
  )
  const uniqueUtilities = [...new Set(allUtilityValues)].sort((a, b) => a - b)

  console.log('\nUtility Distribution Summary:')
  console.log(`  Unique utility values: ${uniqueUtilities.length}`)
  console.log(`  Min utility: ${Math.min(...uniqueUtilities)}`)
  console.log(`  Max utility: ${Math.max(...uniqueUtilities)}`)
  console.log(`  Median utility: ${uniqueUtilities[Math.floor(uniqueUtilities.length / 2)]}`)

  // Check how many cases have unique optimals vs ties
  const uniqueOptimalCount = testCases.filter(tc => tc.optimalSlots.length === 1).length
  console.log(`\nOptimal slot statistics:`)
  console.log(`  Cases with unique optimal: ${uniqueOptimalCount} (${(uniqueOptimalCount / numCases * 100).toFixed(1)}%)`)
  console.log(`  Cases with tied optimals: ${numCases - uniqueOptimalCount} (${((numCases - uniqueOptimalCount) / numCases * 100).toFixed(1)}%)`)
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const numCases = parseInt(process.argv[2] || '100')
  generateBenchmarkData(numCases)
}