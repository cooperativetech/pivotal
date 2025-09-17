// This script creates simple benchmark data for testing the scheduling agent

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { BaseScheduleUser, type BaseScheduleUserData } from './user-sims'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { formatTimestamp } from './utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function createBenchmark(startTimeOffset: number, endTimeOffset: number, meetingLength: number, nAgents: number) {
  // Define date range for fake calendars using offsets from January 1, 2025 midnight EST
  const referenceDate = new Date('2025-01-01T05:00:00Z')
  const startTime = new Date(referenceDate.getTime() + startTimeOffset * 24 * 60 * 60 * 1000)
  const endTime = new Date(referenceDate.getTime() + endTimeOffset * 24 * 60 * 60 * 1000)

  // Possible sim names (one for each letter of the alphabet)
  const possibleSimNames = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Edward', 'Fiona', 'George', 'Helen',
    'Ian', 'Julia', 'Kevin', 'Laura', 'Michael', 'Nina', 'Oliver', 'Patricia',
    'Quinn', 'Rachel', 'Samuel', 'Teresa', 'Ulrich', 'Victoria', 'William', 'Xara',
    'Yasmin', 'Zachary',
  ]

  // Subsample the first nAgents names
  const simNames = possibleSimNames.slice(0, nAgents)

  // Generate fake calendars for all sims
  const calendarEvents = await Promise.all(
    simNames.map(() => genFakeCalendar('America/New_York', startTime, endTime)),
  )

  // Validate and trim calendar events to ensure they fall within the specified date range
  const validatedCalendarEvents = calendarEvents.map((events, simIndex) => {
    const originalLength = events.length
    const filteredEvents = events.filter((event) => {
      const eventStart = new Date(event.start)
      const eventEnd = new Date(event.end)
      return eventStart >= startTime && eventEnd <= endTime
    })

    if (filteredEvents.length < originalLength) {
      const simName = simNames[simIndex]
      const trimmedCount = originalLength - filteredEvents.length
      console.warn(`⚠️  Warning: ${simName} had ${trimmedCount} event(s) outside the date range ${startTime.toISOString()} to ${endTime.toISOString()}. Events trimmed from ${originalLength} to ${filteredEvents.length}.`)
    }

    return filteredEvents
  })

  // Create sims list
  const sims: BaseScheduleUser[] = simNames.map((name, index) => {
    const calendar = convertCalendarEventsToUserProfile(validatedCalendarEvents[index])

    // Only the first sim gets the scheduling goal
    let goal = ''
    if (index === 0) {
      const otherSimNames = simNames.filter((_, i) => i !== index)
      const startTimeStr = startTime.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      })
      const endTimeStr = endTime.toLocaleString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/New_York',
      })

      // Format meeting length appropriately
      const meetingLengthStr = meetingLength >= 60
        ? `${meetingLength / 60}-hour`
        : `${meetingLength}-minute`

      goal = `Schedule a ${meetingLengthStr} meeting between ${startTimeStr} and ${endTimeStr} with ${otherSimNames.join(', ')}`
    }

    return new BaseScheduleUser(name, goal, calendar)
  })

  console.log('Created sims:')
  sims.forEach((sim) => console.log(`${sim.name}: ${sim.calendar.length} events`))

  // Export sims and benchmark parameters to JSON file
  const exportedSims: BaseScheduleUserData[] = sims.map((sim) => sim.export())
  const benchmark = {
    startTime,
    startTimeOffset,
    endTime,
    endTimeOffset,
    meetingLength,
    nAgents,
  }

  const exportData = {
    benchmark,
    agents: exportedSims,
  }

  // Create folder name and filename with benchmark parameters
  const folderName = `benchmark_${nAgents}agents_${startTimeOffset}start_${endTimeOffset}end_${meetingLength}min`
  const timestamp = formatTimestamp()
  const filename = `${folderName}_gen${timestamp}.json`
  const folderPath = join(__dirname, 'data', folderName)

  // Create folder if it doesn't exist
  if (!existsSync(folderPath)) {
    await mkdir(folderPath, { recursive: true })
    console.log(`Created folder: ${folderName}`)
  }

  const filePath = join(folderPath, filename)
  await writeFile(filePath, JSON.stringify(exportData, null, 2))
  console.log(`Agents saved to ${filePath}`)

  return sims
}

// Parse command line arguments
function parseArguments() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      startTimeOffset: {
        type: 'string',
        short: 's',
        default: '1',
      },
      endTimeOffset: {
        type: 'string',
        short: 'e',
        default: '2',
      },
      meetingLength: {
        type: 'string',
        short: 'l',
        default: '60',
      },
      nAgents: {
        type: 'string',
        short: 'a',
        default: '2',
      },
      nCases: {
        type: 'string',
        short: 'c',
        default: '1',
      },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
  })

  if (values.help) {
    console.log('Usage: tsx src/evals/gen-benchmark.ts [options]')
    console.log('\nOptions:')
    console.log('  -s, --startTimeOffset   Start time offset in days from reference date (default: 1)')
    console.log('  -e, --endTimeOffset     End time offset in days from reference date (default: 2)')
    console.log('  -l, --meetingLength     Meeting length in minutes (default: 60)')
    console.log('  -a, --nAgents           Number of simulated users (default: 2)')
    console.log('  -c, --nCases            Number of benchmark cases to generate (default: 1)')
    console.log('  -h, --help              Show this help message')
    process.exit(0)
  }

  return {
    startTimeOffset: parseFloat(values.startTimeOffset),
    endTimeOffset: parseFloat(values.endTimeOffset),
    meetingLength: parseInt(values.meetingLength, 10),
    nAgents: parseInt(values.nAgents, 10),
    nCases: parseInt(values.nCases, 10),
  }
}

// Run the async function with parsed parameters
const { startTimeOffset, endTimeOffset, meetingLength, nAgents, nCases } = parseArguments()
console.log(`Running with parameters: startTimeOffset=${startTimeOffset}, endTimeOffset=${endTimeOffset}, meetingLength=${meetingLength}, nAgents=${nAgents}, nCases=${nCases}`)

async function generateMultipleBenchmarks() {
  console.log(`\nGenerating ${nCases} benchmark case(s)...`)

  for (let i = 1; i <= nCases; i++) {
    console.log(`\n--- Creating benchmark case ${i}/${nCases} ---`)
    await createBenchmark(startTimeOffset, endTimeOffset, meetingLength, nAgents)
  }

  console.log(`\n✅ Successfully generated ${nCases} benchmark case(s)`)
}

generateMultipleBenchmarks().catch(console.error)