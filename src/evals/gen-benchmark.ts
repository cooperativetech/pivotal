// This script creates simple benchmark data for testing the scheduling agent

import { BaseScheduleUser } from './agents/user-agents'
import { genFakeCalendar } from '../agents/gen-fake-calendar'
import { convertCalendarEventsToUserProfile } from '../tools/time_intersection'
import { writeFile } from 'fs/promises'

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

  // Export agents to JSON file
  const exportedAgents: Record<string, unknown>[] = agents.map((agent) => agent.export())
  await writeFile('./src/evals/data/simple-benchmark.json', JSON.stringify(exportedAgents, null, 2))
  console.log('Agents saved to simple-benchmark.json')

  return agents
}

// Run the async function with default parameters
createBenchmark(3, 7, 60, 2).catch(console.error)