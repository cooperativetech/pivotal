#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// Simple test case: Everyone has ONE common free slot on Tuesday
interface SimpleTestCase {
  profiles: {
    name: string
    busySlots: Array<{ start: string; end: string; title: string }>
  }[]
  guaranteedFreeSlot: { start: string; end: string }
  description: string
}

// Generate a simple test case where everyone is free at exactly one time
function generateSimpleTestCase(): SimpleTestCase {
  // The ONE time everyone is free
  const freeSlot = { start: '14:00', end: '15:00' }

  // Create calendars that block everything EXCEPT the free slot
  const profiles = [
    {
      name: 'Alice',
      busySlots: [
        { start: '09:00', end: '11:00', title: 'Morning meetings' },
        { start: '11:00', end: '14:00', title: 'Deep work block' },
        // FREE: 14:00-15:00
        { start: '15:00', end: '17:00', title: 'Afternoon meetings' },
      ],
    },
    {
      name: 'Bob',
      busySlots: [
        { start: '08:00', end: '10:00', title: 'Client calls' },
        { start: '10:00', end: '14:00', title: 'Project work' },
        // FREE: 14:00-15:00
        { start: '15:00', end: '18:00', title: 'Team sync' },
      ],
    },
    {
      name: 'Charlie',
      busySlots: [
        { start: '09:00', end: '12:00', title: 'Development time' },
        { start: '12:00', end: '14:00', title: 'Lunch + errands' },
        // FREE: 14:00-15:00
        { start: '15:00', end: '16:30', title: 'Code review' },
      ],
    },
  ]

  return {
    profiles,
    guaranteedFreeSlot: freeSlot,
    description: `Everyone is free ONLY at ${freeSlot.start}-${freeSlot.end} on Tuesday`,
  }
}

// Convert to format expected by the eval system
function convertToFullFormat(simpleCase: SimpleTestCase) {
  // Create next Tuesday date
  const baseDate = new Date()
  const daysUntilTuesday = (2 - baseDate.getDay() + 7) % 7 || 7
  baseDate.setDate(baseDate.getDate() + daysUntilTuesday)
  baseDate.setHours(0, 0, 0, 0)

  const createDateTime = (time: string) => {
    const [hours, minutes] = time.split(':').map(Number)
    const dt = new Date(baseDate)
    dt.setHours(hours, minutes, 0, 0)
    return dt.toISOString()
  }

  // Convert to full benchmark format
  const profiles = simpleCase.profiles.map((person) => ({
    name: person.name,
    calendar: person.busySlots.map((slot, idx) => ({
      id: `event_${idx}`,
      status: 'confirmed' as const,
      summary: slot.title,
      start: {
        dateTime: createDateTime(slot.start),
        timeZone: 'America/Los_Angeles',
      },
      end: {
        dateTime: createDateTime(slot.end),
        timeZone: 'America/Los_Angeles',
      },
      type: 'meeting' as const,
    })),
    utilityConfig: {
      free: 100,
      blockedWork: 20,
      meeting: 10,
      personal: 30,
      critical: 0,
    },
  }))

  // Calculate utility distribution (simplified - only the free slot gets max utility)
  const utilityDistribution = []

  // Add some blocked slots with low utility
  for (let hour = 9; hour < 18; hour++) {
    for (let min = 0; min < 60; min += 30) {
      const start = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`
      const end = `${hour.toString().padStart(2, '0')}:${(min + 60).toString().padStart(2, '0')}`

      if (start === simpleCase.guaranteedFreeSlot.start) {
        // This is THE free slot - everyone gets max utility
        utilityDistribution.push({
          timeSlot: { start, end: simpleCase.guaranteedFreeSlot.end },
          totalUtility: 500, // 5 people * 100 utility each
        })
      } else {
        // Any other slot has conflicts
        utilityDistribution.push({
          timeSlot: { start, end },
          totalUtility: Math.floor(Math.random() * 200) + 50, // Random low utility
        })
      }
    }
  }

  return {
    id: 0,
    profiles,
    utilityDistribution,
    optimalSlots: [simpleCase.guaranteedFreeSlot],
    optimalUtility: 500,
  }
}

// Generate the simple test case
const simpleCase = generateSimpleTestCase()
const benchmarkCase = convertToFullFormat(simpleCase)

// Save to file
const dataDir = join(import.meta.dirname, '..', 'data')
mkdirSync(dataDir, { recursive: true })

const filename = 'simple-guaranteed-free-slot.json'
const filepath = join(dataDir, filename)

writeFileSync(filepath, JSON.stringify([benchmarkCase], null, 2))

console.log('✅ Generated simple test case:')
console.log(`   File: ${filepath}`)
console.log(`   Description: ${simpleCase.description}`)
console.log(`   Free slot: ${simpleCase.guaranteedFreeSlot.start}-${simpleCase.guaranteedFreeSlot.end}`)
console.log('\nProfiles:')
simpleCase.profiles.forEach((p) => {
  console.log(`   ${p.name}: ${p.busySlots.length} busy blocks`)
})