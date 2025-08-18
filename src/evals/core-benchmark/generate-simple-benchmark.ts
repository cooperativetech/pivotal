import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { CalendarEvent, PersonProfile, TimeSlot } from './generate-benchmark-data'

// Simplified test case that guarantees a common free slot
interface SimpleBenchmarkTestCase {
  id: number
  profiles: PersonProfile[]
  guaranteedFreeSlot: TimeSlot  // The slot that's free for everyone
  description: string
}

// Helper function to convert minutes since midnight to time string
function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

// Create ISO datetime string for next Tuesday at a specific time
function createTuesdayDateTime(time: string): string {
  const baseDate = new Date()
  const daysUntilTuesday = (2 - baseDate.getDay() + 7) % 7 || 7
  baseDate.setDate(baseDate.getDate() + daysUntilTuesday)

  const [hours, minutes] = time.split(':').map(Number)
  baseDate.setHours(hours, minutes, 0, 0)
  return baseDate.toISOString()
}

// Generate a calendar with a guaranteed free slot
function generateCalendarWithFreeSlot(
  personName: string,
  guaranteedFreeSlot: TimeSlot,
  numOtherEvents: number,
): CalendarEvent[] {
  const events: CalendarEvent[] = []

  // Track occupied slots (but NOT the guaranteed free slot)
  const occupiedSlots = new Set<number>()

  // Convert guaranteed free slot to minutes for comparison
  const [freeStartHour, freeStartMin] = guaranteedFreeSlot.start.split(':').map(Number)
  const [freeEndHour, freeEndMin] = guaranteedFreeSlot.end.split(':').map(Number)
  const freeStartMinutes = freeStartHour * 60 + freeStartMin
  const freeEndMinutes = freeEndHour * 60 + freeEndMin

  // Mark the guaranteed free slot as protected
  for (let m = freeStartMinutes; m < freeEndMinutes; m += 30) {
    occupiedSlots.add(m)
  }

  // Add other events that don't conflict with the free slot
  const eventTypes = ['meeting', 'blocked-work', 'personal', 'critical'] as const
  const summaries = {
    meeting: ['Team sync', 'Client call', '1:1 with manager', 'Planning session'],
    'blocked-work': ['Focus time', 'Deep work', 'Project work'],
    personal: ['Lunch', 'Gym', 'Doctor appointment'],
    critical: ['Pick up kids', 'Medical appointment'],
  }

  for (let i = 0; i < numOtherEvents; i++) {
    let attempts = 0
    let eventAdded = false

    while (attempts < 50 && !eventAdded) {
      // Random start time between 8:00 and 17:00 (leaving room for event)
      const startMinutes = Math.floor(Math.random() * (17 * 60 - 8 * 60 - 60) + 8 * 60)
      const roundedStart = Math.floor(startMinutes / 30) * 30

      // Random duration: 30, 60, or 90 minutes
      const duration = [30, 60, 90][Math.floor(Math.random() * 3)]
      const endMinutes = roundedStart + duration

      // Check if this overlaps with any occupied slot
      let overlaps = false
      for (let m = roundedStart; m < endMinutes; m += 30) {
        if (occupiedSlots.has(m)) {
          overlaps = true
          break
        }
      }

      if (!overlaps && endMinutes <= 18 * 60) {
        // Mark these slots as occupied
        for (let m = roundedStart; m < endMinutes; m += 30) {
          occupiedSlots.add(m)
        }

        // Create the event
        const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)]
        const summary = summaries[eventType][Math.floor(Math.random() * summaries[eventType].length)]

        events.push({
          id: `event_${i}_${personName}`,
          status: 'confirmed',
          summary,
          start: {
            dateTime: createTuesdayDateTime(minutesToTime(roundedStart)),
            timeZone: 'America/Los_Angeles',
          },
          end: {
            dateTime: createTuesdayDateTime(minutesToTime(endMinutes)),
            timeZone: 'America/Los_Angeles',
          },
          organizer: {
            email: `${personName.toLowerCase()}@example.com`,
          },
          type: eventType,
        })

        eventAdded = true
      }

      attempts++
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

// Generate a simple test case with guaranteed overlap
function generateSimpleTestCase(id: number): SimpleBenchmarkTestCase {
  // Pick a random time slot that will be free for everyone
  const possibleFreeSlots: TimeSlot[] = [
    { start: '09:00', end: '10:00' },
    { start: '10:30', end: '11:30' },
    { start: '14:00', end: '15:00' },
    { start: '15:30', end: '16:30' },
    { start: '16:00', end: '17:00' },
  ]

  const guaranteedFreeSlot = possibleFreeSlots[Math.floor(Math.random() * possibleFreeSlots.length)]

  // Generate profiles with the guaranteed free slot
  const names = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve']
  const profiles: PersonProfile[] = []

  for (const name of names) {
    // Each person has 2-5 other events (not in the free slot)
    const numOtherEvents = Math.floor(Math.random() * 4) + 2

    profiles.push({
      name,
      calendar: generateCalendarWithFreeSlot(name, guaranteedFreeSlot, numOtherEvents),
      utilityConfig: {
        free: 100,
        blockedWork: 70,
        meeting: 20,
        personal: 40,
        critical: 0,
      },
    })
  }

  return {
    id,
    profiles,
    guaranteedFreeSlot,
    description: `Test case ${id}: All participants have ${guaranteedFreeSlot.start}-${guaranteedFreeSlot.end} free on Tuesday`,
  }
}

export function generateSimpleBenchmarkData(numCases: number = 20): void {
  console.log(`Generating ${numCases} simple benchmark test cases with guaranteed free slots...`)

  const testCases: SimpleBenchmarkTestCase[] = []

  for (let i = 0; i < numCases; i++) {
    testCases.push(generateSimpleTestCase(i))
  }

  // Ensure data directory exists
  const dataDir = join(import.meta.dirname, '..', 'data')
  mkdirSync(dataDir, { recursive: true })

  // Save to file
  const filename = `simple-benchmark-${numCases}-cases.json`
  const filepath = join(dataDir, filename)
  writeFileSync(filepath, JSON.stringify(testCases, null, 2))

  console.log(`\nGenerated ${numCases} test cases`)
  console.log(`Saved to: ${filepath}`)

  // Print summary
  const slotCounts = new Map<string, number>()
  for (const tc of testCases) {
    const key = `${tc.guaranteedFreeSlot.start}-${tc.guaranteedFreeSlot.end}`
    slotCounts.set(key, (slotCounts.get(key) || 0) + 1)
  }

  console.log('\nGuaranteed free slot distribution:')
  for (const [slot, count] of slotCounts) {
    console.log(`  ${slot}: ${count} cases (${(count / numCases * 100).toFixed(1)}%)`)
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const numCases = parseInt(process.argv[2] || '20')
  generateSimpleBenchmarkData(numCases)
}