// This script creates simple benchmark data for testing the scheduling agent

import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { BaseScheduleUser } from './sim-users'
import { type BaseScheduleUserData } from './utils'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { formatTimestamp } from './utils'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function createBenchmark(startTimeOffset: number, endTimeOffset: number, meetingLength: number, nSimUsers: number, nGroups: number) {
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

  // Subsample the first nSimUsers names
  const simUserNames = possibleSimUserNames.slice(0, nSimUsers)

  // Validate nGroups parameter
  if (nGroups > 1) {
    const minUsersPerGroup = 2
    const minRequiredUsers = nGroups * minUsersPerGroup
    if (nSimUsers < minRequiredUsers) {
      throw new Error(`Cannot divide ${nSimUsers} users into ${nGroups} groups with at least ${minUsersPerGroup} users each. Need at least ${minRequiredUsers} users.`)
    }
  }

  // Divide users into groups if nGroups > 1
  let userGroups: string[][]
  if (nGroups === 1) {
    userGroups = [simUserNames]
  } else {
    // Initialize empty groups
    userGroups = Array.from({ length: nGroups }, () => [])
    const remainingUsers = [...simUserNames]

    // First two passes: give each group two users using nested loop
    for (let pass = 0; pass < 2; pass++) {
      for (let groupIndex = 0; groupIndex < nGroups; groupIndex++) {
        const randomIndex = Math.floor(Math.random() * remainingUsers.length)
        const user = remainingUsers.splice(randomIndex, 1)[0]
        userGroups[groupIndex].push(user)
      }
    }

    // Distribute remaining users randomly
    while (remainingUsers.length > 0) {
      const randomGroupIndex = Math.floor(Math.random() * nGroups)
      const randomUserIndex = Math.floor(Math.random() * remainingUsers.length)
      const user = remainingUsers.splice(randomUserIndex, 1)[0]
      userGroups[randomGroupIndex].push(user)
    }
  }

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

  // Create simUsers list with group-based goal assignment
  const simUsers: BaseScheduleUser[] = simUserNames.map((name, index) => {
    const calendar = convertCalendarEventsToUserProfile(validatedCalendarEvents[index])

    // Determine goal based on group assignment
    let goal = ''

    if (nGroups === 1) {
      // Original behavior: only the first simUser gets the scheduling goal
      if (index === 0) {
        const otherSimUserNames = simUserNames.filter((_, i) => i !== index)
        goal = createGoalString(otherSimUserNames, startTime, endTime, meetingLength)
      }
    } else {
      // Group-based behavior: first user in each group gets the scheduling goal
      for (const group of userGroups) {
        if (group[0] === name) {
          const otherUsersInGroup = group.slice(1)
          goal = createGoalString(otherUsersInGroup, startTime, endTime, meetingLength)
          break
        }
      }
    }

    return new BaseScheduleUser(name, goal, calendar)
  })

  // Helper function to create goal string
  function createGoalString(otherUsers: string[], startTime: Date, endTime: Date, meetingLength: number): string {
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

    return `Schedule a ${meetingLengthStr} meeting between ${startTimeStr} and ${endTimeStr} with ${otherUsers.join(', ')}`
  }

  console.log('Created simUsers:')
  simUsers.forEach((simUser) => console.log(`${simUser.name}: ${simUser.calendar.length} events`))

  // Export simUsers and benchmark parameters to JSON file
  const exportedSimUsers: BaseScheduleUserData[] = simUsers.map((simUser) => simUser.export())

  // Create dictionary mapping each sim user to their group index
  const userGroupMapping: Record<string, number> = {}
  userGroups.forEach((group, groupIndex) => {
    group.forEach((userName) => {
      userGroupMapping[userName] = groupIndex
    })
  })

  // Generate timestamp for this benchmark
  const timestamp = formatTimestamp()

  const benchmark = {
    startTime,
    startTimeOffset,
    endTime,
    endTimeOffset,
    meetingLength,
    nSimUsers,
    nGroups,
    userGroupMapping,
    genTimestamp: timestamp,
  }

  const exportData = {
    benchmark,
    simUsers: exportedSimUsers,
  }

  // Create folder name and filename with benchmark parameters
  const folderName = `benchmark_${nSimUsers}simusers_${nGroups}groups_${startTimeOffset.toString().replace('.', '-')}start_${endTimeOffset.toString().replace('.', '-')}end_${meetingLength}min`
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

  return simUsers
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
      nSimUsers: {
        type: 'string',
        short: 'a',
        default: '2',
      },
      nCases: {
        type: 'string',
        short: 'c',
        default: '1',
      },
      nGroups: {
        type: 'string',
        short: 'g',
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
    console.log('  -a, --nSimUsers         Number of simulated users (default: 2)')
    console.log('  -c, --nCases            Number of benchmark cases to generate (default: 1)')
    console.log('  -g, --nGroups           Number of groups to divide users into (default: 1)')
    console.log('  -h, --help              Show this help message')
    process.exit(0)
  }

  return {
    startTimeOffset: parseFloat(values.startTimeOffset),
    endTimeOffset: parseFloat(values.endTimeOffset),
    meetingLength: parseInt(values.meetingLength, 10),
    nSimUsers: parseInt(values.nSimUsers, 10),
    nCases: parseInt(values.nCases, 10),
    nGroups: parseInt(values.nGroups, 10),
  }
}

// Run the async function with parsed parameters
const { startTimeOffset, endTimeOffset, meetingLength, nSimUsers, nCases, nGroups } = parseArguments()
console.log(`Running with parameters: startTimeOffset=${startTimeOffset}, endTimeOffset=${endTimeOffset}, meetingLength=${meetingLength}, nSimUsers=${nSimUsers}, nCases=${nCases}, nGroups=${nGroups}`)

async function generateMultipleBenchmarks() {
  console.log(`\nGenerating ${nCases} benchmark case(s)...`)

  for (let i = 1; i <= nCases; i++) {
    console.log(`\n--- Creating benchmark case ${i}/${nCases} ---`)
    await createBenchmark(startTimeOffset, endTimeOffset, meetingLength, nSimUsers, nGroups)
  }

  console.log(`\n✅ Successfully generated ${nCases} benchmark case(s)`)
}

generateMultipleBenchmarks().catch(console.error)
