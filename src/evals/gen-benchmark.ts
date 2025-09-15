// This script creates simple benchmark data for testing the scheduling agent

import { BaseScheduleUser } from './agents/user-agents'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { formatTimestamp } from './utils'

async function createBenchmark(startTimeOffset: number, endTimeOffset: number, meetingLength: number, nAgents: number) {
  // Define date range for fake calendars using offsets from January 1, 2025
  const referenceDate = new Date('2025-01-01T00:00:00Z')
  const startTime = new Date(referenceDate)
  startTime.setDate(referenceDate.getDate() + startTimeOffset)
  const endTime = new Date(referenceDate)
  endTime.setDate(referenceDate.getDate() + endTimeOffset)

  // Possible agent names (one for each letter of the alphabet)
  const possibleAgentNames = [
    'Alice', 'Bob', 'Charlie', 'Diana', 'Edward', 'Fiona', 'George', 'Helen',
    'Ian', 'Julia', 'Kevin', 'Laura', 'Michael', 'Nina', 'Oliver', 'Patricia',
    'Quinn', 'Rachel', 'Samuel', 'Teresa', 'Ulrich', 'Victoria', 'William', 'Xara',
    'Yasmin', 'Zachary'
  ]

  // Subsample the first nAgents names
  const agentNames = possibleAgentNames.slice(0, nAgents)

  // Generate fake calendars for all agents
  const calendarEvents = await Promise.all(
    agentNames.map(() => genFakeCalendar('America/New_York', startTime, endTime)),
  )

  // Create agents list
  const agents: BaseScheduleUser[] = agentNames.map((name, index) => {
    const calendar = convertCalendarEventsToUserProfile(calendarEvents[index])
    
    // Only the first agent gets the scheduling goal
    let goal = ''
    if (index === 0) {
      const otherAgentNames = agentNames.filter((_, i) => i !== index)
      const startTimeStr = startTime.toLocaleString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })
      const endTimeStr = endTime.toLocaleString('en-US', { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      })
      
      // Format meeting length appropriately
      const meetingLengthStr = meetingLength >= 60 
        ? `${meetingLength / 60}-hour` 
        : `${meetingLength}-minute`
      
      goal = `Schedule a ${meetingLengthStr} meeting between ${startTimeStr} and ${endTimeStr} with ${otherAgentNames.join(', ')}`
    }
    
    return new BaseScheduleUser(name, goal, calendar)
  })

  console.log('Created agents:')
  agents.forEach((agent) => console.log(`${agent.name}: ${agent.calendar.length} events`))

  // Export agents and benchmark parameters to JSON file
  const exportedAgents: Record<string, unknown>[] = agents.map((agent) => agent.export())
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
    agents: exportedAgents,
  }
  
  // Create folder name and filename with benchmark parameters
  const folderName = `benchmark_${nAgents}agents_${startTimeOffset}start_${endTimeOffset}end_${meetingLength}min`
  const timestamp = formatTimestamp()
  const filename = `${folderName}_gen${timestamp}.json`
  const folderPath = join('./src/evals/data', folderName)
  
  // Create folder if it doesn't exist
  if (!existsSync(folderPath)) {
    await mkdir(folderPath, { recursive: true })
    console.log(`Created folder: ${folderName}`)
  }
  
  const filePath = join(folderPath, filename)
  await writeFile(filePath, JSON.stringify(exportData, null, 2))
  console.log(`Agents saved to ${filePath}`)

  return agents
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2)
  const defaults = {
    startTimeOffset: 1,
    endTimeOffset: 2,
    meetingLength: 60,
    nAgents: 2,
  }

  // Parse named arguments (--arg=value format)
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=')
      if (key === 'startTimeOffset' || key === 'start') {
        defaults.startTimeOffset = parseInt(value, 10)
      } else if (key === 'endTimeOffset' || key === 'end') {
        defaults.endTimeOffset = parseInt(value, 10)
      } else if (key === 'meetingLength' || key === 'length') {
        defaults.meetingLength = parseInt(value, 10)
      } else if (key === 'nAgents' || key === 'agents') {
        defaults.nAgents = parseInt(value, 10)
      }
    }
  }

  // Parse positional arguments (backwards compatibility)
  if (args.length >= 1 && !args[0].startsWith('--')) {
    defaults.startTimeOffset = parseInt(args[0], 10)
  }
  if (args.length >= 2 && !args[1].startsWith('--')) {
    defaults.endTimeOffset = parseInt(args[1], 10)
  }
  if (args.length >= 3 && !args[2].startsWith('--')) {
    defaults.meetingLength = parseInt(args[2], 10)
  }
  if (args.length >= 4 && !args[3].startsWith('--')) {
    defaults.nAgents = parseInt(args[3], 10)
  }

  return defaults
}

// Run the async function with parsed parameters
const { startTimeOffset, endTimeOffset, meetingLength, nAgents } = parseArgs()
console.log(`Running with parameters: startTimeOffset=${startTimeOffset}, endTimeOffset=${endTimeOffset}, meetingLength=${meetingLength}, nAgents=${nAgents}`)
createBenchmark(startTimeOffset, endTimeOffset, meetingLength, nAgents).catch(console.error)