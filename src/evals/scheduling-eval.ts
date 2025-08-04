// Scheduling evaluation system for finding optimal meeting times

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

// Result of evaluating a time slot
export interface EvaluationResult {
  proposedTime: TimeSlot
  totalUtility: number
  maxPossibleUtility: number
  minPossibleUtility: number
  percentile: number // 0-100, where 100 is the best possible time
  individualScores: Array<{
    person: string
    utility: number
    conflictingEvent?: CalendarEvent
  }>
}

// Helper function to convert time string to minutes since midnight
export function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

// Helper function to convert minutes since midnight to time string
export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

// Check if two time slots overlap
export function timeSlotsOverlap(slot1: TimeSlot, slot2: TimeSlot): boolean {
  const start1 = timeToMinutes(slot1.start)
  const end1 = timeToMinutes(slot1.end)
  const start2 = timeToMinutes(slot2.start)
  const end2 = timeToMinutes(slot2.end)

  return start1 < end2 && start2 < end1
}

// Calculate utility for a person given a proposed time slot
export function calculatePersonUtility(
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
export function calculateTotalUtility(
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
export function generateAllTimeSlots(): TimeSlot[] {
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

// Find min and max possible utilities across all time slots
export function findMinMaxUtilities(profiles: PersonProfile[]): { min: number; max: number; allScores: Map<string, number> } {
  const allSlots = generateAllTimeSlots()
  const allScores = new Map<string, number>()

  let min = Infinity
  let max = -Infinity

  for (const slot of allSlots) {
    const { total } = calculateTotalUtility(profiles, slot)
    const key = `${slot.start}-${slot.end}`
    allScores.set(key, total)

    if (total < min) min = total
    if (total > max) max = total
  }

  return { min, max, allScores }
}

// Main evaluation function
export function evaluateMeetingTime(
  profiles: PersonProfile[],
  proposedTime: TimeSlot,
): EvaluationResult {
  // Calculate utility for proposed time
  const { total, individual } = calculateTotalUtility(profiles, proposedTime)

  // Find min/max across all possible times
  const { min, max, allScores } = findMinMaxUtilities(profiles)

  // Calculate percentile (0-100 scale)
  // If this is optimal (equals max), it's 100th percentile
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

  // Otherwise, calculate what percentage of slots are worse
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
    percentile: Math.round(percentile * 100) / 100, // Round to 2 decimal places
    individualScores: individual,
  }
}

// Create the 5 person profiles with Tuesday schedules
export function createTestProfiles(): PersonProfile[] {
  // Standard utility configuration (can be customized per person)
  const standardUtility: UtilityConfig = {
    free: 100,
    blockedWork: 70,
    meeting: 20,
    personal: 40,
    critical: 0,
  }

  const profiles: PersonProfile[] = [
    {
      name: 'Sarah',
      calendar: [
        { start: '09:00', end: '10:00', type: 'meeting', description: 'Team standup' },
        { start: '10:00', end: '12:00', type: 'blocked-work', description: 'Deep work time' },
        { start: '12:00', end: '13:00', type: 'personal', description: 'Lunch' },
        { start: '15:00', end: '16:00', type: 'meeting', description: 'Client call' },
        { start: '17:30', end: '18:30', type: 'critical', description: 'Pick up kids from school' },
      ],
      utilityConfig: standardUtility,
    },
    {
      name: 'Bob',
      calendar: [
        { start: '08:00', end: '09:00', type: 'personal', description: 'Gym' },
        { start: '10:00', end: '11:00', type: 'meeting', description: '1:1 with manager' },
        { start: '11:00', end: '13:00', type: 'blocked-work', description: 'Code review' },
        { start: '14:00', end: '15:00', type: 'meeting', description: 'Design review' },
        { start: '16:00', end: '17:00', type: 'personal', description: 'Laundry pickup' },
      ],
      utilityConfig: standardUtility,
    },
    {
      name: 'Luke',
      calendar: [
        { start: '09:30', end: '10:30', type: 'meeting', description: 'Sprint planning' },
        { start: '11:00', end: '12:00', type: 'blocked-work', description: 'Focus time' },
        { start: '12:00', end: '13:30', type: 'personal', description: 'Long lunch' },
        { start: '14:00', end: '16:00', type: 'blocked-work', description: 'Project work' },
        { start: '18:00', end: '19:00', type: 'critical', description: 'Doctor appointment' },
      ],
      utilityConfig: standardUtility,
    },
    {
      name: 'John',
      calendar: [
        { start: '07:00', end: '08:00', type: 'personal', description: 'Morning run' },
        { start: '09:00', end: '10:00', type: 'meeting', description: 'Department meeting' },
        { start: '10:30', end: '12:30', type: 'blocked-work', description: 'Report writing' },
        { start: '13:00', end: '14:00', type: 'meeting', description: 'Vendor call' },
        { start: '15:30', end: '16:30', type: 'critical', description: 'School conference' },
      ],
      utilityConfig: standardUtility,
    },
    {
      name: 'Susan',
      calendar: [
        { start: '08:30', end: '09:30', type: 'meeting', description: 'Executive briefing' },
        { start: '10:00', end: '11:00', type: 'blocked-work', description: 'Strategic planning' },
        { start: '11:30', end: '12:30', type: 'meeting', description: 'Board prep' },
        { start: '14:00', end: '15:00', type: 'personal', description: 'Dentist' },
        { start: '16:00', end: '18:00', type: 'blocked-work', description: 'Proposal review' },
      ],
      utilityConfig: standardUtility,
    },
  ]

  return profiles
}

// Example usage
export function runExample() {
  const profiles = createTestProfiles()

  // Test a few different time slots
  const testSlots: TimeSlot[] = [
    { start: '08:00', end: '09:00' }, // Early morning
    { start: '13:00', end: '14:00' }, // Lunch time
    { start: '15:00', end: '16:00' }, // Mid-afternoon
    { start: '17:00', end: '18:00' }, // End of day
  ]

  console.log('Scheduling Evaluation Results:')
  console.log('==============================\\n')

  for (const slot of testSlots) {
    const result = evaluateMeetingTime(profiles, slot)
    console.log(`Proposed time: ${slot.start} - ${slot.end}`)
    console.log(`Total utility: ${result.totalUtility} (min: ${result.minPossibleUtility}, max: ${result.maxPossibleUtility})`)
    console.log(`Percentile: ${result.percentile}% (higher is better)`)
    console.log('Individual impacts:')

    for (const score of result.individualScores) {
      const impact = score.conflictingEvent
        ? `conflicts with "${score.conflictingEvent.description}"`
        : 'is free'
      console.log(`  - ${score.person}: ${score.utility} utility (${impact})`)
    }
    console.log('\\n')
  }
}