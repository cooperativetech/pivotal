// This script creates simple benchmark data for testing the scheduling agent

import { BaseScheduleUser } from './agents/user-agents'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'

function formatTimestamp(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0')
  
  return `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`
}

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

// Run the async function with default parameters
createBenchmark(1, 2, 60, 2).catch(console.error)