// This script creates simple benchmark data for testing the scheduling agent

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { BaseScheduleUser } from './sim-users'
import { type BaseScheduleUserData } from './utils'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { formatTimestamp } from './utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function createBenchmark(startTimeOffset: number, endTimeOffset: number, meetingLength: number, nSimUsers: number, genTimestamp: string, nGroups?: number, groupIndex?: number) {
  // Define date range for fake calendars using offsets from January 1, 2025 midnight EST
  const referenceDate = new Date('2025-01-01T05:00:00Z')
  const startTime = new Date(referenceDate.getTime() + startTimeOffset * 24 * 60 * 60 * 1000)
  const endTime = new Date(referenceDate.getTime() + endTimeOffset * 24 * 60 * 60 * 1000)

  // Possible simUser names (one for each letter of the alphabet)
  const possibleSimUserNames = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Edward', 'Fiona', 'George', 'Helen',
    'Ian', 'Julia', 'Kevin', 'Laura', 'Michael', 'Nina', 'Oliver', 'Patricia',
    'Quinn', 'Rachel', 'Samuel', 'Teresa', 'Ulrich', 'Victoria', 'William', 'Xara',
    'Yasmin', 'Zachary',
  ]

  // Randomly sample nSimUsers names
  const shuffledNames = [...possibleSimUserNames].sort(() => Math.random() - 0.5)
  const simUserNames = shuffledNames.slice(0, nSimUsers)

  // Generate fake calendars for all simUsers
  const calendarEvents = await Promise.all(
    simUserNames.map(() => genFakeCalendar('America/New_York', startTime, endTime)),
  )

  // Validate and trim calendar events to ensure they fall within the specified date range
  const validatedCalendarEvents = calendarEvents.map((events, simUserIndex) => {
    const originalLength = events.length
    const filteredEvents = events.filter((event) => {
      const eventStart = new Date(event.start)
      const eventEnd = new Date(event.end)
      return eventStart >= startTime && eventEnd <= endTime
    })

    if (filteredEvents.length < originalLength) {
      const simUserName = simUserNames[simUserIndex]
      const trimmedCount = originalLength - filteredEvents.length
      console.warn(`⚠️  Warning: ${simUserName} had ${trimmedCount} event(s) outside the date range ${startTime.toISOString()} to ${endTime.toISOString()}. Events trimmed from ${originalLength} to ${filteredEvents.length}.`)
    }

    return filteredEvents
  })

  // Create simUsers list
  const simUsers: BaseScheduleUser[] = simUserNames.map((name, index) => {
    const calendar = convertCalendarEventsToUserProfile(validatedCalendarEvents[index])

    // Only the first simUser gets the scheduling goal
    let goal = ''
    if (index === 0) {
      const otherSimUserNames = simUserNames.filter((_, i) => i !== index)
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

      goal = `Schedule a ${meetingLengthStr} meeting between ${startTimeStr} and ${endTimeStr} with ${otherSimUserNames.join(', ')}`
    }

    return new BaseScheduleUser(name, goal, calendar)
  })

  console.log('Created simUsers:')
  simUsers.forEach((simUser) => console.log(`${simUser.name}: ${simUser.calendar.length} events`))

  // Export simUsers and benchmark parameters
  const exportedSimUsers: BaseScheduleUserData[] = simUsers.map((simUser) => simUser.export())

  const benchmark = {
    startTime,
    startTimeOffset,
    endTime,
    endTimeOffset,
    meetingLength,
    nSimUsers,
    genTimestamp,
    ...(nGroups !== undefined && { nGroups }),
    ...(groupIndex !== undefined && { groupIndex }),
  }

  const exportData = {
    benchmark,
    simUsers: exportedSimUsers,
  }

  return exportData
}



// Parse command line arguments
function parseArguments() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      startTimeOffset: {
        type: 'string',
        short: 's',
        default: '1.25',
      },
      endTimeOffset: {
        type: 'string',
        short: 'e',
        default: '1.75',
      },
      meetingLength: {
        type: 'string',
        short: 'l',
        default: '60',
      },
      nSimUsers: {
        type: 'string',
        short: 'a',
        default: '2',
      },
      nGroups: {
        type: 'string',
        short: 'g',
        default: '1',
      },
      genTimestamp: {
        type: 'string',
        short: 't',
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
    console.log('  -a, --nSimUsers         Number of simulated users (default: 2)')
    console.log('  -g, --nGroups           Number of groups to generate (default: 1)')
    console.log('  -t, --genTimestamp      Use existing generation timestamp (appends to existing folder)')
    console.log('  -h, --help              Show this help message')
    process.exit(0)
  }

  return {
    startTimeOffset: parseFloat(values.startTimeOffset),
    endTimeOffset: parseFloat(values.endTimeOffset),
    meetingLength: parseInt(values.meetingLength, 10),
    nSimUsers: parseInt(values.nSimUsers, 10),
    nGroups: parseInt(values.nGroups, 10),
    genTimestamp: values.genTimestamp || null,
  }
}

// Run the async function with parsed parameters
const { startTimeOffset, endTimeOffset, meetingLength, nSimUsers, nGroups, genTimestamp } = parseArguments()
console.log(`Running with parameters: startTimeOffset=${startTimeOffset}, endTimeOffset=${endTimeOffset}, meetingLength=${meetingLength}, nSimUsers=${nSimUsers}, nGroups=${nGroups}, genTimestamp=${genTimestamp || 'new'}`)

async function generateMultiGroupBenchmarks() {
  console.log(`\nGenerating benchmark with ${nGroups} group(s)...`)

  // Setup folder structure under benchmarks directory
  const benchmarksPath = join(__dirname, 'data', 'benchmarks')
  let targetFolder: string
  let nextGroupNumber = 1
  let useTimestamp: string

  // Ensure benchmarks directory exists
  if (!existsSync(benchmarksPath)) {
    await mkdir(benchmarksPath, { recursive: true })
    console.log('Created benchmarks directory')
  }

  if (genTimestamp) {
    // Use provided timestamp - find any existing folder with this genTimestamp
    useTimestamp = genTimestamp

    const existingFolders = readdirSync(benchmarksPath)
    const matchingFolder = existingFolders.find((folder) => folder.endsWith(`_gen${useTimestamp}`))

    if (!matchingFolder) {
      throw new Error(`No existing folder found for genTimestamp ${genTimestamp}. No folder ending with _gen${genTimestamp} found in benchmarks directory.`)
    }

    targetFolder = join(benchmarksPath, matchingFolder)
    // Count existing files to determine next group number
    const existingFiles = readdirSync(targetFolder)
    nextGroupNumber = existingFiles.length + 1
    console.log(`Using existing folder: ${matchingFolder}, next group will be ${nextGroupNumber}`)
  } else {
    // Create new folder with new timestamp using current parameters
    useTimestamp = formatTimestamp()
    const folderName = `benchmark_${nSimUsers}simusers_${startTimeOffset.toString().replace('.', '-')}start_${endTimeOffset.toString().replace('.', '-')}end_${meetingLength}min_gen${useTimestamp}`

    targetFolder = join(benchmarksPath, folderName)
    await mkdir(targetFolder, { recursive: true })
    console.log(`Created new folder: ${folderName}`)
  }

  // Create nGroups independent benchmark groups
  for (let groupIndex = 0; groupIndex < nGroups; groupIndex++) {
    console.log(`\n--- Creating group ${groupIndex + 1}/${nGroups} ---`)

    // Call createBenchmark for each group
    const exportData = await createBenchmark(startTimeOffset, endTimeOffset, meetingLength, nSimUsers, useTimestamp, nGroups, groupIndex)

    // Save with group-specific filename using nextGroupNumber
    const actualGroupNumber = nextGroupNumber + groupIndex
    const baseName = `benchmark_${nSimUsers}simusers_${startTimeOffset.toString().replace('.', '-')}start_${endTimeOffset.toString().replace('.', '-')}end_${meetingLength}min`
    const filename = `${baseName}_gen${useTimestamp}_group${actualGroupNumber}.json`
    const filePath = join(targetFolder, filename)

    await writeFile(filePath, JSON.stringify(exportData, null, 2))
    console.log(`Group ${groupIndex + 1} benchmark saved to ${filePath}`)
  }

  console.log(`\n✅ Successfully generated benchmark with ${nGroups} group(s)`)
}

generateMultiGroupBenchmarks().catch(console.error)